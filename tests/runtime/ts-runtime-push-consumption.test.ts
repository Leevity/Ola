import { beforeEach, expect, it, vi } from 'vitest'
import type { RunEvent, RunSnapshot } from '../../src/shared/runtime/contracts'

const state = vi.hoisted(() => ({
  invoke: vi.fn<(channel: string, payload: unknown) => Promise<unknown>>(),
  listeners: new Map<string, ((...args: unknown[]) => void)[]>(),
  /** The bridge mints its own run id; frames must carry the id it actually uses. */
  runId: ''
}))

vi.mock('../../src/renderer/src/stores/chat-store', () => ({
  awaitPendingSessionCreate: async () => undefined
}))
vi.mock('../../src/renderer/src/lib/ipc/messagepack-ipc-client', () => ({
  invokeMessagePackBinary: state.invoke
}))
vi.mock('../../src/renderer/src/lib/ipc/ipc-client', () => ({
  ipcClient: {
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      const list = state.listeners.get(channel) ?? []
      list.push(listener)
      state.listeners.set(channel, list)
      return () => {
        state.listeners.set(
          channel,
          (state.listeners.get(channel) ?? []).filter((candidate) => candidate !== listener)
        )
      }
    }
  }
}))

import { streamTsRuntimeTextTurn } from '../../src/renderer/src/lib/ipc/ts-runtime-bridge'

function event(seq: number, type: string, data: unknown): RunEvent {
  return {
    runId: state.runId,
    workspaceId: 'team-a',
    seq,
    traceId: 'trace',
    type,
    data,
    timestamp: seq
  }
}

function snapshot(input: {
  seq: number
  status: string
  events: RunEvent[]
  pending?: RunSnapshot['pendingInteractions']
}): RunSnapshot {
  return {
    run: { runId: state.runId, workspaceId: 'team-a', status: input.status, seq: input.seq },
    events: input.events,
    pendingInteractions: input.pending ?? []
  } as RunSnapshot
}

function emit(channel: string, frame: unknown): void {
  for (const listener of state.listeners.get(channel) ?? []) listener(frame)
}

/** Lets the generator reach its next suspended `yield` or `await`. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function turn() {
  return {
    workspaceId: 'team-a',
    sessionId: 'session-a',
    modelSource: { kind: 'local' as const, providerId: 'provider', modelId: 'model' },
    prompt: 'hello',
    onRunIdAssigned: (runId: string) => {
      state.runId = runId
    }
  }
}

beforeEach(() => {
  state.invoke.mockReset()
  state.listeners.clear()
  state.runId = ''
})

it('projects pushed events in sequence and reads interactions once on waiting_interaction', async () => {
  let subscribed = false
  state.invoke.mockImplementation(async (channel: string) => {
    if (channel.startsWith('ts-runtime:run-submit')) return { accepted: true }
    if (channel.startsWith('ts-runtime:run-subscribe')) {
      subscribed = true
      return {
        subscriptionId: 'sub-a',
        snapshot: snapshot({
          seq: 1,
          status: 'running',
          events: [event(1, 'run.status', { status: 'running' })]
        })
      }
    }
    if (channel.startsWith('ts-runtime:run-snapshot')) {
      return {
        snapshot: snapshot({
          seq: 3,
          status: 'waiting_interaction',
          events: [event(2, 'message.delta', { text: 'pushed' })],
          pending: [
            {
              runId: state.runId,
              workspaceId: 'team-a',
              interactionId: 'ask-1',
              kind: 'question',
              payload: { question: 'continue?' },
              createdAt: 1
            },
            {
              runId: state.runId,
              workspaceId: 'team-a',
              interactionId: 'ask-2',
              kind: 'tool-approval',
              payload: { toolName: 'Write' },
              createdAt: 2
            }
          ]
        })
      }
    }
    if (channel.startsWith('ts-runtime:run-unsubscribe')) return { unsubscribed: true }
    if (channel.startsWith('ts-runtime:run-cancel')) return { cancelled: true }
    return {}
  })

  const stream = streamTsRuntimeTextTurn(turn())
  const received: string[] = []
  const collect = async (count: number): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
      const next = await stream.next()
      expect(next.done).toBe(false)
      received.push(next.value.type)
    }
  }

  // run.status(running) from the subscribe snapshot.
  await collect(1)
  await vi.waitFor(() => expect(subscribed).toBe(true))
  // Push arrival is what drives the next projection; no polling.
  const runId = state.runId
  emit('ts-runtime:run-event', {
    workspaceId: 'team-a',
    runId,
    subscriptionId: 'sub-a',
    event: event(2, 'message.delta', { text: 'pushed' })
  })
  await collect(1)
  expect(state.invoke).not.toHaveBeenCalledWith(
    'ts-runtime:run-snapshot:msgpack',
    expect.anything()
  )
  // waiting_interaction owes exactly one snapshot for the pending set.
  emit('ts-runtime:run-event', {
    workspaceId: 'team-a',
    runId,
    subscriptionId: 'sub-a',
    event: event(3, 'run.status', { status: 'waiting_interaction' })
  })
  await collect(2)
  expect(received).toEqual([
    'message_start',
    'text_delta',
    'runtime_interaction_requested',
    'runtime_interaction_requested'
  ])
  const snapshotCalls = state.invoke.mock.calls.filter(([channel]) =>
    channel.startsWith('ts-runtime:run-snapshot')
  )
  expect(snapshotCalls).toHaveLength(1)
})

it('falls back to the snapshot loop when Main cannot push', async () => {
  state.invoke.mockImplementation(async (channel: string) => {
    if (channel.startsWith('ts-runtime:run-submit')) return { accepted: true }
    if (channel.startsWith('ts-runtime:run-subscribe')) {
      return { subscriptionId: null, snapshot: null, error: 'PUSH_DISABLED' }
    }
    if (channel.startsWith('ts-runtime:run-snapshot')) {
      return {
        snapshot: snapshot({
          seq: 3,
          status: 'completed',
          events: [
            event(1, 'run.status', { status: 'running' }),
            event(2, 'message.delta', { text: 'polled' }),
            event(3, 'run.status', { status: 'completed' })
          ]
        })
      }
    }
    return {}
  })
  const stream = streamTsRuntimeTextTurn(turn())
  const types: string[] = []
  for (;;) {
    const next = await stream.next()
    if (next.done) break
    types.push(next.value.type)
    if (types.at(-1) === 'loop_end') break
  }
  expect(types).toEqual(['message_start', 'text_delta', 'loop_end'])
  expect(
    state.invoke.mock.calls.filter(([channel]) => channel.startsWith('ts-runtime:run-snapshot'))
  ).toHaveLength(1)
})

it('reconciles from the journal after a resync instead of trusting the stream', async () => {
  let subscribeCalls = 0
  state.invoke.mockImplementation(async (channel: string) => {
    if (channel.startsWith('ts-runtime:run-submit')) return { accepted: true }
    if (channel.startsWith('ts-runtime:run-subscribe')) {
      subscribeCalls += 1
      return {
        subscriptionId: `sub-${subscribeCalls}`,
        snapshot: snapshot({
          seq: subscribeCalls === 1 ? 1 : 2,
          status: 'running',
          events:
            subscribeCalls === 1
              ? [event(1, 'run.status', { status: 'running' })]
              : [event(2, 'message.delta', { text: 'recovered' })]
        })
      }
    }
    if (channel.startsWith('ts-runtime:run-snapshot')) {
      return {
        snapshot: snapshot({
          seq: 3,
          status: 'completed',
          events: [event(3, 'run.status', { status: 'completed' })]
        })
      }
    }
    return {}
  })
  const stream = streamTsRuntimeTextTurn(turn())
  const first = await stream.next()
  expect(first.value.type).toBe('message_start')
  await tick()
  emit('ts-runtime:run-resync', {
    workspaceId: 'team-a',
    runId: state.runId,
    subscriptionId: 'sub-1',
    reason: 'SLOW_CONSUMER'
  })
  const types: string[] = []
  for (;;) {
    const next = await stream.next()
    if (next.done) break
    types.push(next.value.type)
    if (types.at(-1) === 'loop_end') break
  }
  expect(types).toEqual(['text_delta', 'loop_end'])
  expect(subscribeCalls).toBe(2)
})
