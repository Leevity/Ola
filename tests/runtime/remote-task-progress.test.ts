import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { RunEvent } from '../../src/shared/runtime/contracts'
import type { RemoteTaskSnapshot } from '../../src/shared/remote-control'
import {
  beginRemoteTaskRun,
  currentRemoteTaskSnapshot,
  endRemoteTaskRun,
  publishRemoteRunEvent,
  resetRemoteTask,
  resetRemoteTaskIfIdle,
  replayRemoteTask,
  setRemoteTaskPublisher,
  setRemoteTaskSender
} from '../../src/renderer/src/lib/remote/remote-task-progress'

/**
 * The projection is what a controller sees instead of the run journal, so these
 * tests pin the parts a remote operator actually depends on: the prompt, the
 * tool steps and the terminal status.
 */

let pushed: RemoteTaskSnapshot[] = []
let published: RemoteTaskSnapshot[] = []

function event(seq: number, type: string, data: unknown, runId = 'run-1'): RunEvent {
  return { runId, workspaceId: 'ws-1', seq, traceId: 'trace-1', type, data, timestamp: 1000 + seq }
}

beforeEach(() => {
  resetRemoteTask()
  pushed = []
  published = []
  setRemoteTaskSender((snapshot) => pushed.push(snapshot))
  setRemoteTaskPublisher((snapshot) => published.push(snapshot))
})

describe('remote task projection', () => {
  it('shows the prompt that started the run', () => {
    beginRemoteTaskRun('run-1', '列出当前工作目录下前 5 个文件名\n然后总结')
    const snapshot = currentRemoteTaskSnapshot()
    expect(snapshot?.title).toBe('列出当前工作目录下前 5 个文件名 然后总结')
    expect(snapshot?.status).toBe('running')
    expect(pushed.at(-1)?.runId).toBe('run-1')
  })

  it('joins tool events into one step with its outcome', () => {
    beginRemoteTaskRun('run-1', '列出文件')
    publishRemoteRunEvent('run-1', event(1, 'run.status', { status: 'running' }))
    publishRemoteRunEvent(
      'run-1',
      event(2, 'tool.generated', { id: 't1', name: 'Bash', input: { command: 'ls -1' } })
    )
    publishRemoteRunEvent(
      'run-1',
      event(3, 'tool.result', { id: 't1', name: 'Bash', output: 'a\nb' })
    )
    const snapshot = currentRemoteTaskSnapshot()
    expect(snapshot?.steps).toHaveLength(1)
    expect(snapshot?.steps[0]).toMatchObject({ id: 't1', name: 'Bash', status: 'completed' })
    expect(snapshot?.steps[0].summary).toBe('ls -1')
    expect(snapshot?.steps[0].output).toBe('a b')
  })

  it('records a tool result whose generation event was never seen', () => {
    beginRemoteTaskRun('run-1', '列出文件')
    publishRemoteRunEvent(
      'run-1',
      event(1, 'tool.result', { id: 't9', name: 'LS', output: 'a\nb' })
    )
    const snapshot = currentRemoteTaskSnapshot()
    expect(snapshot?.steps).toHaveLength(1)
    expect(snapshot?.steps[0]).toMatchObject({ id: 't9', name: 'LS', status: 'completed' })
    expect(snapshot?.steps[0].output).toBe('a b')
  })

  it('marks a failing tool as failed instead of completed', () => {
    beginRemoteTaskRun('run-1', '读文件')
    publishRemoteRunEvent(
      'run-1',
      event(1, 'tool.generated', { id: 't1', name: 'Read', input: { path: '/nope' } })
    )
    publishRemoteRunEvent(
      'run-1',
      event(2, 'tool.result', { id: 't1', name: 'Read', output: 'ENOENT', isError: true })
    )
    expect(currentRemoteTaskSnapshot()?.steps[0].status).toBe('failed')
  })

  it('accumulates assistant text and reports a terminal status', () => {
    beginRemoteTaskRun('run-1', '打个招呼')
    publishRemoteRunEvent('run-1', event(1, 'message.delta', { text: '你好，' }))
    publishRemoteRunEvent('run-1', event(2, 'message.delta', { text: '我是 Ola。' }))
    publishRemoteRunEvent('run-1', event(3, 'run.status', { status: 'completed' }))
    const snapshot = currentRemoteTaskSnapshot()
    expect(snapshot?.text).toBe('你好，我是 Ola。')
    expect(snapshot?.status).toBe('completed')
    expect(snapshot?.done).toBe(true)
    // A terminal frame must reach the controller immediately, not on the timer.
    expect(pushed.at(-1)?.done).toBe(true)
  })

  it('keeps the terminal status when the stream closes afterwards', () => {
    beginRemoteTaskRun('run-1', '跑一下')
    publishRemoteRunEvent('run-1', event(1, 'run.status', { status: 'failed' }))
    endRemoteTaskRun('run-1', 'cancelled')
    expect(currentRemoteTaskSnapshot()?.status).toBe('failed')
  })

  it('reports an interrupted run when the stream ends without a status', () => {
    beginRemoteTaskRun('run-1', '跑一下')
    endRemoteTaskRun('run-1', 'interrupted')
    expect(currentRemoteTaskSnapshot()).toMatchObject({ status: 'interrupted', done: true })
  })

  it('ignores events from another run', () => {
    beginRemoteTaskRun('run-1', '第一个任务')
    publishRemoteRunEvent('run-2', event(1, 'message.delta', { text: '不该出现' }, 'run-2'))
    expect(currentRemoteTaskSnapshot()?.text).toBe('')
  })

  it('keeps one task view across the turns of the same prompt', () => {
    beginRemoteTaskRun('run-1', '列出文件', 'session-1')
    publishRemoteRunEvent(
      'run-1',
      event(1, 'tool.generated', { id: 't1', name: 'LS', input: { path: '.' } })
    )
    publishRemoteRunEvent('run-1', event(2, 'tool.result', { id: 't1', name: 'LS', output: 'a' }))
    publishRemoteRunEvent('run-1', event(3, 'run.status', { status: 'completed' }))

    // The agent loop submits the next turn as a new run with the same prompt.
    beginRemoteTaskRun('run-2', '列出文件', 'session-1')
    const snapshot = currentRemoteTaskSnapshot()
    expect(snapshot).toMatchObject({ runId: 'run-2', status: 'running', done: false })
    expect(snapshot?.steps.map((step) => step.name)).toEqual(['LS'])
  })

  it('starts a new task when the prompt changes', () => {
    beginRemoteTaskRun('run-1', '列出文件', 'session-1')
    publishRemoteRunEvent(
      'run-1',
      event(1, 'tool.generated', { id: 't1', name: 'LS', input: { path: '.' } })
    )
    beginRemoteTaskRun('run-2', '再读一遍 README', 'session-1')
    const snapshot = currentRemoteTaskSnapshot()
    expect(snapshot?.title).toBe('再读一遍 README')
    expect(snapshot?.steps).toHaveLength(0)
  })

  it('starts a new task when the same prompt is re-sent long after it finished', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    beginRemoteTaskRun('run-1', '列出文件', 'session-1')
    publishRemoteRunEvent('run-1', event(1, 'message.delta', { text: '第一遍结果' }))
    publishRemoteRunEvent('run-1', event(2, 'run.status', { status: 'completed' }))
    // The operator deliberately runs the same prompt again; that is a new task,
    // not the agent loop's next turn, so the old answer must not ride along.
    clock.mockReturnValue(1_000_000 + 6 * 60_000)
    beginRemoteTaskRun('run-2', '列出文件', 'session-1')
    const snapshot = currentRemoteTaskSnapshot()
    expect(snapshot).toMatchObject({ runId: 'run-2', status: 'running', text: '', steps: [] })
    clock.mockRestore()
  })

  it('keeps an in-flight task when the control session closes', () => {
    beginRemoteTaskRun('run-1', '长时间任务', 'session-1')
    publishRemoteRunEvent(
      'run-1',
      event(1, 'tool.generated', { id: 't1', name: 'Bash', input: { command: 'sleep 60' } })
    )
    resetRemoteTaskIfIdle()
    // The next controller replays this instead of finding an empty panel for
    // the rest of a run it can no longer observe.
    expect(currentRemoteTaskSnapshot()?.steps.map((step) => step.name)).toEqual(['Bash'])
  })

  it('drops a finished task when the control session closes', () => {
    beginRemoteTaskRun('run-1', '跑完了', 'session-1')
    publishRemoteRunEvent('run-1', event(1, 'run.status', { status: 'completed' }))
    resetRemoteTaskIfIdle()
    expect(currentRemoteTaskSnapshot()).toBeNull()
  })

  it('starts a new task in another session even with the same prompt', () => {
    beginRemoteTaskRun('run-1', '列出文件', 'session-1')
    publishRemoteRunEvent('run-1', event(1, 'message.delta', { text: '旧任务' }))
    beginRemoteTaskRun('run-2', '列出文件', 'session-2')
    expect(currentRemoteTaskSnapshot()?.text).toBe('')
  })

  it('keeps only the tail of a long answer', () => {
    beginRemoteTaskRun('run-1', '长回答')
    publishRemoteRunEvent('run-1', event(1, 'message.delta', { text: 'x'.repeat(5000) }))
    publishRemoteRunEvent('run-1', event(2, 'message.delta', { text: 'END' }))
    const text = currentRemoteTaskSnapshot()?.text ?? ''
    expect(text.length).toBe(4000)
    expect(text.endsWith('END')).toBe(true)
  })

  it('caps the step list so the panel cannot grow without bound', () => {
    beginRemoteTaskRun('run-1', '很多步骤')
    for (let index = 0; index < 50; index += 1) {
      publishRemoteRunEvent(
        'run-1',
        event(index + 1, 'tool.generated', {
          id: `t${index}`,
          name: 'Bash',
          input: { command: 'ls' }
        })
      )
    }
    const steps = currentRemoteTaskSnapshot()?.steps ?? []
    expect(steps).toHaveLength(40)
    expect(steps.at(-1)?.id).toBe('t49')
  })

  it('replays the live projection to a controller that joins late', () => {
    beginRemoteTaskRun('run-1', '正在跑')
    publishRemoteRunEvent('run-1', event(1, 'message.delta', { text: '处理中' }))
    resetRemoteTaskSender()
    pushed = []
    setRemoteTaskSender((snapshot) => pushed.push(snapshot))
    expect(replayRemoteTask()).toBe(true)
    expect(pushed.at(-1)?.text).toBe('处理中')
  })

  it('reports nothing to replay when no run is tracked', () => {
    expect(replayRemoteTask()).toBe(false)
  })

  it('carries the working directory so the steps make sense', () => {
    beginRemoteTaskRun('run-1', '列出文件', 'session-1', '/Users/me/project')
    publishRemoteRunEvent(
      'run-1',
      event(1, 'tool.generated', { id: 't1', name: 'Bash', input: { command: 'ls -1' } })
    )
    const snapshot = currentRemoteTaskSnapshot()
    expect(snapshot?.workingDirectory).toBe('/Users/me/project')
    expect(published.at(-1)?.workingDirectory).toBe('/Users/me/project')
  })

  it('keeps the directory across turns of the same task', () => {
    beginRemoteTaskRun('run-1', '重构这个模块', 'session-1', '/work/app')
    endRemoteTaskRun('run-1', 'completed')
    // The next run of the same prompt continues the view and has not been told
    // the directory again; dropping it would blank the heading mid-task.
    beginRemoteTaskRun('run-2', '重构这个模块', 'session-1')
    expect(currentRemoteTaskSnapshot()?.workingDirectory).toBe('/work/app')
  })

  it('adopts the directory a tool reports when the session has none', () => {
    beginRemoteTaskRun('run-1', '读文件', 'session-1')
    expect(currentRemoteTaskSnapshot()?.workingDirectory).toBeUndefined()
    publishRemoteRunEvent(
      'run-1',
      event(1, 'tool.generated', {
        id: 't1',
        name: 'Read',
        input: { path: 'src/index.ts', cwd: '/Users/me/app' }
      })
    )
    expect(currentRemoteTaskSnapshot()?.workingDirectory).toBe('/Users/me/app')
  })

  it('keeps the directory the session already declared', () => {
    beginRemoteTaskRun('run-1', '读文件', 'session-1', '/work/app')
    publishRemoteRunEvent(
      'run-1',
      event(1, 'tool.generated', { id: 't1', name: 'Bash', input: { command: 'ls', cwd: '/tmp' } })
    )
    expect(currentRemoteTaskSnapshot()?.workingDirectory).toBe('/work/app')
  })

  it('publishes the same projection to the control plane sink', () => {
    beginRemoteTaskRun('run-1', '跑测试', 'session-1', '/work/app')
    publishRemoteRunEvent('run-1', event(1, 'run.status', { status: 'completed' }))
    const last = published.at(-1)
    expect(last?.status).toBe('completed')
    expect(last?.done).toBe(true)
    expect(last?.sessionId).toBe('session-1')
  })
})

function resetRemoteTaskSender(): void {
  setRemoteTaskSender(null)
}
