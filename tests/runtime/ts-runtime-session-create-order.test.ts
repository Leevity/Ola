import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  awaitCreate: vi.fn<() => Promise<void>>(),
  invoke: vi.fn()
}))
vi.mock('../../src/renderer/src/stores/chat-store', () => ({
  awaitPendingSessionCreate: state.awaitCreate
}))
vi.mock('../../src/renderer/src/lib/ipc/messagepack-ipc-client', () => ({
  invokeMessagePackBinary: state.invoke
}))

import { streamTsRuntimeTextTurn } from '../../src/renderer/src/lib/ipc/ts-runtime-bridge'

it('waits for a new business session before submitting its TS run', async () => {
  let release!: () => void
  state.awaitCreate.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  state.invoke.mockRejectedValue(new Error('SUBMIT_MARKER'))
  const stream = streamTsRuntimeTextTurn({
    workspaceId: 'team-a',
    sessionId: 'session-a',
    modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
    prompt: 'hello'
  })
  const next = stream.next()
  await vi.waitFor(() => expect(state.awaitCreate).toHaveBeenCalledWith('session-a'))
  expect(state.invoke).not.toHaveBeenCalled()
  release()
  await expect(next).rejects.toThrow('SUBMIT_MARKER')
  expect(state.invoke).toHaveBeenCalledWith(
    'ts-runtime:run-submit:msgpack',
    expect.objectContaining({ sessionId: 'session-a', workspaceId: 'team-a' })
  )
})
