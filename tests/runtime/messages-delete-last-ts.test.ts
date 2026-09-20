import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  deleteLastMessage: vi.fn(),
  routeGuard: vi.fn()
}))

vi.mock('../../src/main/db/business-write-canary', () => ({
  businessWriteCanary: () => ({ deleteLastMessage: state.deleteLastMessage }),
  getTsDatabaseRouteGuard: () => {
    state.routeGuard()
    throw new Error('message delete-last entered the legacy route guard')
  }
}))

import { deleteLastMessage } from '../../src/main/db/messages-dao'

describe('TS message delete-last route', () => {
  beforeEach(() => {
    state.deleteLastMessage.mockReset()
    state.routeGuard.mockReset()
    state.deleteLastMessage.mockResolvedValue({ id: 'message-a', role: 'assistant' })
  })

  it('uses the workspace-scoped TS repository and requires workspace ownership', async () => {
    await expect(deleteLastMessage('session-a', 'assistant', 'team-a')).resolves.toEqual({
      id: 'message-a',
      role: 'assistant'
    })
    expect(state.deleteLastMessage).toHaveBeenCalledWith({
      sessionId: 'session-a',
      workspaceId: 'team-a',
      role: 'assistant'
    })
    expect(state.routeGuard).not.toHaveBeenCalled()
    await expect(deleteLastMessage('session-a', 'assistant')).rejects.toThrow(
      'TS_BUSINESS_WORKSPACE_REQUIRED'
    )
  })
})
