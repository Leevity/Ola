import assert from 'node:assert/strict'
import {
  buildDeterministicFinalOutcome,
  generateFinalOutcome,
  resolveFinalOutcomeStatus
} from '../src/renderer/src/lib/agent/final-outcome.ts'
import type { ToolCallState } from '../src/renderer/src/lib/agent/types.ts'

function tool(
  id: string,
  status: ToolCallState['status'],
  patch: Partial<ToolCallState> = {}
): ToolCallState {
  return {
    id,
    name: patch.name ?? 'Shell',
    input: patch.input ?? {},
    status,
    requiresApproval: false,
    ...patch
  }
}

const completedTool = tool('completed', 'completed', {
  input: { path: 'C:\\workspace\\result.md', authorization: 'Bearer very-secret-token' }
})
const failedTool = tool('failed', 'error', { error: 'Command failed' })

assert.equal(resolveFinalOutcomeStatus('completed', [completedTool]), 'completed')
assert.equal(resolveFinalOutcomeStatus('completed', [completedTool, failedTool]), 'failed')
assert.equal(resolveFinalOutcomeStatus('max_iterations', [completedTool]), 'partial')
assert.equal(resolveFinalOutcomeStatus('aborted', [completedTool]), 'canceled')
assert.equal(resolveFinalOutcomeStatus('error', []), 'failed')

const partial = buildDeterministicFinalOutcome(
  {
    goal: '帮我完成这个任务',
    loopEndReason: 'max_iterations',
    toolCalls: [completedTool],
    durationMs: 500
  },
  3
)
assert.equal(partial.status, 'partial')
assert.equal(partial.title, '任务部分完成')
assert.equal(partial.source, 'deterministic')
assert.equal(partial.attemptCount, 3)
assert.ok(partial.warnings.some((warning) => warning.includes('最大轮次')))

const fallback = await generateFinalOutcome({
  goal: 'Summarize this tool run',
  loopEndReason: 'completed',
  toolCalls: [completedTool],
  durationMs: 500,
  providers: []
})
assert.equal(fallback.status, 'completed')
assert.equal(fallback.source, 'deterministic')
assert.equal(fallback.attemptCount, 3)
assert.ok(JSON.stringify(fallback).includes('result.md'))
assert.ok(!JSON.stringify(fallback).includes('very-secret-token'))

const canceled = await generateFinalOutcome({
  goal: 'Cancel this run',
  loopEndReason: 'aborted',
  toolCalls: [completedTool],
  durationMs: 500,
  providers: []
})
assert.equal(canceled.status, 'canceled')
assert.equal(canceled.attemptCount, 0)

console.log('run-lifecycle verification passed')
