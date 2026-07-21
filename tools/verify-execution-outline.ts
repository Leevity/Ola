import assert from 'node:assert/strict'
import type { ContentBlock } from '../src/renderer/src/lib/api/types.ts'
import { buildExecutionOutline, classifyTool } from '../src/renderer/src/components/chat/execution-outline.ts'

const tool = (id: string, name: string): ContentBlock => ({ type: 'tool_use', id, name, input: {} })

assert.equal(classifyTool('Read'), 'context')
assert.equal(classifyTool('Bash'), 'command')
assert.equal(classifyTool('Edit'), 'file-change')
assert.equal(classifyTool('mcp__github__get_issue'), 'mcp')
assert.equal(classifyTool('browser_click'), 'browser')
assert.equal(classifyTool('desktop_screenshot'), 'visual')
assert.equal(classifyTool('AskUserQuestion'), 'interactive')
assert.equal(classifyTool('future_tool'), 'unknown')

const splitRuns = buildExecutionOutline([
  tool('read-1', 'Read'),
  tool('grep-1', 'Grep'),
  { type: 'text', text: '解释文本' },
  tool('bash-1', 'Bash')
])
assert.equal(splitRuns.length, 2)
assert.deepEqual(splitRuns.map((run) => run.visibleItems.length), [2, 1])
assert.equal(splitRuns[0].defaultExpanded, false)

const failed = buildExecutionOutline([tool('unknown-1', 'future_tool')], {
  toolResults: new Map([['unknown-1', { content: '失败详情', isError: true }]])
})[0]
assert.equal(failed.status, 'failed')
assert.equal(failed.defaultExpanded, true)
assert.equal(failed.visibleItems[0].visibility, 'force')

const runningUnknown = buildExecutionOutline([tool('unknown-2', 'future_tool')], {
  isStreaming: true
})[0]
assert.equal(runningUnknown.status, 'running')
assert.equal(runningUnknown.visibleItems[0].visibility, 'force')

const completedUnknown = buildExecutionOutline([tool('unknown-3', 'future_tool')])[0]
assert.equal(completedUnknown.status, 'completed')
assert.equal(completedUnknown.defaultExpanded, false)

const approval = buildExecutionOutline([tool('ask-1', 'AskUserQuestion')])[0]
assert.equal(approval.defaultExpanded, true)
assert.equal(approval.visibleItems[0].visibility, 'force')

const internal = buildExecutionOutline([tool('task-1', 'TaskCreate')])
assert.equal(internal.length, 0)

const alwaysExpanded = buildExecutionOutline([tool('read-2', 'Read')], { alwaysExpand: true })[0]
assert.equal(alwaysExpanded.defaultExpanded, true)

console.log('execution-outline verification passed')
