import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnifiedMessage } from '../../src/renderer/src/lib/api/types'

const fixture = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../../src/renderer/src/lib/ipc/messagepack-ipc-client', () => ({
  invokeMessagePackBinary: fixture.invoke,
  invokeMessagePack: fixture.invoke
}))
vi.mock('../../src/renderer/src/stores/agent-store', () => ({
  useAgentStore: { getState: () => ({}) }
}))

import { useChatStore, type Session } from '../../src/renderer/src/stores/chat-store'
import { DB_MESSAGES_REPLACE_MSGPACK_CHANNEL } from '../../src/shared/messagepack/binary-ipc'

let nextSession = 0

function message(id: string, content: string): UnifiedMessage {
  return { id, role: 'user', content, createdAt: Date.now() }
}

function installSession(messages: UnifiedMessage[]): string {
  const id = `compression-persist-${++nextSession}`
  const session: Session = {
    id,
    title: 'Compression persistence',
    mode: 'chat',
    taskProfile: 'work',
    taskProfileLocked: false,
    messages,
    messageCount: messages.length,
    messagesLoaded: true,
    loadedRangeStart: 0,
    loadedRangeEnd: messages.length,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    workspaceId: 'local-personal'
  }
  useChatStore.setState({ sessions: [session], sessionsById: { [id]: 0 }, activeSessionId: id })
  return id
}

describe('context compression message persistence', () => {
  beforeEach(() => {
    fixture.invoke.mockReset()
    fixture.invoke.mockResolvedValue({ success: true })
  })

  it('keeps the original transcript when replacement fails to write', async () => {
    const original = [message('original', 'Original text')]
    const id = installSession(original)
    fixture.invoke.mockRejectedValueOnce(new Error('disk full'))

    await expect(
      useChatStore.getState().replaceSessionMessagesPersisted(id, [message('summary', 'Summary')])
    ).rejects.toThrow('disk full')

    expect(useChatStore.getState().sessions[0].messages).toBe(original)
    expect(fixture.invoke).toHaveBeenCalledWith(
      DB_MESSAGES_REPLACE_MSGPACK_CHANNEL,
      expect.objectContaining({ sessionId: id, workspaceId: 'local-personal' })
    )
  })

  it('only shows a replacement after the database acknowledges it', async () => {
    const original = [message('original', 'Original text')]
    const id = installSession(original)
    let completeWrite: ((value: unknown) => void) | undefined
    fixture.invoke.mockImplementationOnce(
      () =>
        new Promise((resolveWrite) => {
          completeWrite = resolveWrite
        })
    )

    const pending = useChatStore
      .getState()
      .replaceSessionMessagesPersisted(id, [message('summary', 'Summary')])
    await vi.waitFor(() => expect(completeWrite).toBeTypeOf('function'))
    expect(useChatStore.getState().sessions[0].messages).toBe(original)

    completeWrite?.({ success: true })
    await expect(pending).resolves.toBe(true)
    expect(useChatStore.getState().sessions[0].messages[0].content).toBe('Summary')
  })

  it('preserves a newer transcript if it changes while replacement is writing', async () => {
    const original = [message('original', 'Original text')]
    const id = installSession(original)
    let completeWrite: ((value: unknown) => void) | undefined
    fixture.invoke.mockImplementationOnce(
      () =>
        new Promise((resolveWrite) => {
          completeWrite = resolveWrite
        })
    )

    const pending = useChatStore
      .getState()
      .replaceSessionMessagesPersisted(id, [message('summary', 'Summary')])
    await vi.waitFor(() => expect(completeWrite).toBeTypeOf('function'))
    const newer = [...original, message('newer', 'New user turn')]
    useChatStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, messages: newer, messageCount: newer.length } : session
      )
    }))
    completeWrite?.({ success: true })

    await expect(pending).resolves.toBe(false)
    expect(useChatStore.getState().sessions[0].messages).toBe(newer)
    expect(fixture.invoke).toHaveBeenNthCalledWith(
      2,
      DB_MESSAGES_REPLACE_MSGPACK_CHANNEL,
      expect.objectContaining({
        sessionId: id,
        messages: expect.arrayContaining([expect.objectContaining({ id: 'newer' })])
      })
    )
  })
})
