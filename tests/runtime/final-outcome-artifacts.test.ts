import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/lib/ipc/ts-runtime-bridge', () => ({
  isTsRuntimeAvailable: async () => false,
  streamTsRuntimeTextTurn: async function* () {
    yield* []
  }
}))
vi.mock('../../src/renderer/src/lib/ipc/ts-runtime-model-binding', () => ({
  resolveTsRuntimeModelBinding: () => null
}))
import {
  buildDeterministicFinalOutcome,
  resolveFinalOutcomeStatus
} from '../../src/renderer/src/lib/agent/final-outcome'
import type { ToolCallState } from '../../src/renderer/src/lib/agent/types'

function call(
  name: string,
  status: ToolCallState['status'],
  input: Record<string, unknown>
): ToolCallState {
  return {
    id: `${name}-${status}`,
    name,
    status,
    input,
    requiresApproval: false
  }
}

describe('final outcome artifact evidence', () => {
  it('lists only paths from completed file-writing tools', () => {
    const outcome = buildDeterministicFinalOutcome(
      {
        sessionId: 'test-session',
        workspaceId: 'local-personal',
        goal: 'Create a report',
        loopEndReason: 'completed',
        toolCalls: [
          call('Write', 'completed', { file_path: '/work/report.md' }),
          call('Write', 'error', { file_path: '/work/failed.md' }),
          call('Read', 'completed', { file_path: '/work/source.md' }),
          call('run_shell_command', 'completed', { command: 'echo https://example.com' })
        ],
        durationMs: 10
      },
      0
    )
    expect(outcome.artifacts).toEqual([
      { label: 'report.md', path: '/work/report.md', kind: 'file' }
    ])
  })

  it('maps every run terminal state and redacts secret values from deterministic outcomes', () => {
    const successfulCall = call('Write', 'completed', {
      file_path: 'C:\\workspace\\report.md',
      authorization: 'Bearer very-secret-token'
    })
    const failedCall = {
      ...call('Shell', 'error', {}),
      error: 'request failed with sk-12345678901234567890'
    }
    expect(resolveFinalOutcomeStatus('completed', [successfulCall])).toBe('completed')
    expect(resolveFinalOutcomeStatus('completed', [successfulCall, failedCall])).toBe('failed')
    expect(resolveFinalOutcomeStatus('max_iterations', [successfulCall])).toBe('partial')
    expect(resolveFinalOutcomeStatus('aborted', [successfulCall])).toBe('canceled')
    expect(resolveFinalOutcomeStatus('error', [])).toBe('failed')

    const outcome = buildDeterministicFinalOutcome(
      {
        sessionId: 'test-session',
        workspaceId: 'local-personal',
        goal: '帮我完成这个任务',
        loopEndReason: 'max_iterations',
        toolCalls: [successfulCall, failedCall],
        durationMs: 500
      },
      3
    )
    const serialized = JSON.stringify(outcome)
    expect(outcome.status).toBe('partial')
    expect(outcome.title).toBe('任务部分完成')
    expect(outcome.attemptCount).toBe(3)
    expect(outcome.warnings.some((warning) => warning.includes('最大轮次'))).toBe(true)
    expect(serialized).toContain('report.md')
    expect(serialized).not.toContain('very-secret-token')
    expect(serialized).not.toContain('sk-12345678901234567890')
  })
})
