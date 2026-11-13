import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteTaskSnapshot } from '../../src/shared/remote-control'

/**
 * The control-plane feed is the path that lets an operator follow a task with
 * no screen session, so what matters is: nothing leaves the machine while
 * remote access is off, the frames that do leave are coalesced, and the last
 * word of a run always gets through.
 */

const invocations: Array<Record<string, unknown>> = []

vi.mock('../../src/renderer/src/lib/ipc/ipc-client', () => ({
  ipcClient: {
    invoke: async (_channel: string, request: Record<string, unknown>) => {
      invocations.push(request)
      return { success: true }
    }
  }
}))

const { configureRemoteTaskFeed, publishRemoteTaskFeed } = await import(
  '../../src/renderer/src/lib/remote/remote-task-feed'
)

function snapshot(overrides: Partial<RemoteTaskSnapshot> = {}): RemoteTaskSnapshot {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    status: 'running',
    title: '列出文件',
    workingDirectory: '/work/app',
    startedAt: 1_760_000_000_000,
    text: '处理中',
    steps: [
      {
        id: 'step-1',
        name: 'Bash',
        status: 'running',
        startedAt: 1_760_000_000_100,
        summary: 'ls -1'
      }
    ],
    seq: 3,
    updatedAt: 1_760_000_000_200,
    done: false,
    ...overrides
  }
}

/** Lets the async delivery settle without advancing fake timers. */
async function drain(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  invocations.length = 0
  configureRemoteTaskFeed(null)
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-07T10:00:00Z'))
})

describe('remote task feed', () => {
  it('sends nothing while remote access is off', async () => {
    configureRemoteTaskFeed({ apiBaseUrl: 'https://cp.example', deviceId: 'dev-1', enabled: false })
    publishRemoteTaskFeed(snapshot())
    await vi.advanceTimersByTimeAsync(5000)
    await drain()
    expect(invocations).toHaveLength(0)
  })

  it('publishes the projection with its directory and steps', async () => {
    configureRemoteTaskFeed({ apiBaseUrl: 'https://cp.example', deviceId: 'dev-1', enabled: true })
    publishRemoteTaskFeed(snapshot())
    await vi.advanceTimersByTimeAsync(1)
    await drain()
    expect(invocations).toHaveLength(1)
    const payload = invocations[0].payload as {
      deviceId: string
      task: Record<string, unknown>
    }
    expect(invocations[0].operation).toBe('device-task-publish')
    expect(payload.deviceId).toBe('dev-1')
    expect(payload.task.workingDirectory).toBe('/work/app')
    expect((payload.task.steps as Array<Record<string, unknown>>)[0].summary).toBe('ls -1')
  })

  it('coalesces a burst of events into one report per interval', async () => {
    configureRemoteTaskFeed({ apiBaseUrl: 'https://cp.example', deviceId: 'dev-1', enabled: true })
    publishRemoteTaskFeed(snapshot({ text: 'a' }))
    await vi.advanceTimersByTimeAsync(1)
    await drain()

    for (const text of ['ab', 'abc', 'abcd']) {
      publishRemoteTaskFeed(snapshot({ text }))
      await vi.advanceTimersByTimeAsync(200)
    }
    await vi.advanceTimersByTimeAsync(2000)
    await drain()

    expect(invocations.length).toBe(2)
    const last = invocations.at(-1)?.payload as { task: Record<string, unknown> }
    // The newest state wins: a queued frame must never be delivered after a
    // fresher one.
    expect(last.task.text).toBe('abcd')
  })

  it('sends a terminal frame without waiting for the interval', async () => {
    configureRemoteTaskFeed({ apiBaseUrl: 'https://cp.example', deviceId: 'dev-1', enabled: true })
    publishRemoteTaskFeed(snapshot())
    await vi.advanceTimersByTimeAsync(1)
    await drain()

    publishRemoteTaskFeed(snapshot({ status: 'completed', done: true, text: '完成' }))
    await drain()

    expect(invocations.length).toBe(2)
    const last = invocations.at(-1)?.payload as { task: Record<string, unknown> }
    expect(last.task.status).toBe('completed')
    expect(last.task.done).toBe(true)
  })

  it('drops a queued frame when the feed is repointed', async () => {
    configureRemoteTaskFeed({ apiBaseUrl: 'https://cp.example', deviceId: 'dev-1', enabled: true })
    publishRemoteTaskFeed(snapshot())
    configureRemoteTaskFeed({
      apiBaseUrl: 'https://other.example',
      deviceId: 'dev-2',
      enabled: true
    })
    await vi.advanceTimersByTimeAsync(5000)
    await drain()
    // The queue belonged to the previous target; delivering it would report
    // this machine's work to the wrong control plane.
    for (const call of invocations) {
      const payload = call.payload as { deviceId: string }
      expect(payload.deviceId).toBe('dev-2')
    }
  })
})
