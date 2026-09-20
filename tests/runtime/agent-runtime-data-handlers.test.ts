import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  handler: null as ((args: unknown, event: unknown) => Promise<unknown>) | null,
  appendHandler: null as ((args: unknown, event: unknown) => Promise<unknown>) | null,
  results: vi.fn(),
  getSession: vi.fn(),
  addMessages: vi.fn()
}))

const webContents = { mainFrame: {} }
const window = { webContents, isDestroyed: () => false }
const event = { sender: webContents, senderFrame: webContents.mainFrame }

vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => window } }))
vi.mock('../../src/main/ipc/messagepack-handler', () => ({
  registerMessagePackHandler: (
    channel: string,
    handler: (args: unknown, event: unknown) => Promise<unknown>
  ) => {
    if (channel === 'agent:append-messages') state.appendHandler = handler
    if (channel === 'agent:tool-results-lookup') state.handler = handler
  }
}))
vi.mock('../../src/main/window-ipc', () => ({
  getRegisteredWindowWorkspace: () => 'team-a'
}))
vi.mock('../../src/main/db/business-write-canary', () => ({
  businessWriteCanary: () => ({ runtimeToolResults: state.results })
}))
vi.mock('../../src/main/db/sessions-dao', () => ({ getSession: state.getSession }))
vi.mock('../../src/main/db/messages-dao', () => ({ addMessages: state.addMessages }))

import { registerAgentRuntimeDataHandlers } from '../../src/main/ipc/agent-runtime-data-handlers'

describe('TS Agent runtime durable data routes', () => {
  beforeEach(() => {
    state.handler = null
    state.appendHandler = null
    state.results.mockReset()
    state.getSession.mockReset()
    state.addMessages.mockReset()
    state.getSession.mockResolvedValue({ id: 'session-a' })
    registerAgentRuntimeDataHandlers()
  })

  it('looks up tool results through the TS BusinessRepository with workspace scope', async () => {
    state.results.mockResolvedValue([{ toolUseId: 'tool-1', contentJson: '{}' }])
    await expect(
      state.handler?.(
        { workspaceId: 'team-a', sessionId: 'session-a', toolUseIds: ['tool-1'] },
        event
      )
    ).resolves.toEqual({ results: [{ toolUseId: 'tool-1', contentJson: '{}' }] })
    expect(state.results).toHaveBeenCalledWith('session-a', 'team-a', ['tool-1'])
  })

  it('appends session messages through the TS message DAO', async () => {
    const message = {
      id: 'message-1',
      sessionId: 'session-a',
      workspaceId: 'team-a',
      role: 'assistant',
      content: 'done',
      createdAt: 1,
      sortOrder: 1
    }
    await expect(
      state.appendHandler?.(
        { workspaceId: 'team-a', sessionId: 'session-a', messages: [message] },
        event
      )
    ).resolves.toEqual({ success: true })
    expect(state.addMessages).toHaveBeenCalledWith([message])
  })

  it('fails closed on workspace mismatch and malformed ids', async () => {
    await expect(
      state.handler?.(
        { workspaceId: 'team-b', sessionId: 'session-a', toolUseIds: ['tool-1'] },
        event
      )
    ).resolves.toMatchObject({ results: [], error: 'WINDOW_WORKSPACE_MISMATCH' })
    await expect(
      state.handler?.({ workspaceId: 'team-a', sessionId: '', toolUseIds: [] }, event)
    ).resolves.toMatchObject({ results: [], error: 'INVALID_SESSION' })
  })
})
