import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  updateSession: vi.fn(),
  routeGuard: vi.fn()
}))

vi.mock('../../src/main/db/business-write-canary', () => ({
  businessWriteCanary: () => ({ updateSession: state.updateSession }),
  getTsDatabaseRouteGuard: state.routeGuard
}))

vi.mock('../../src/main/db/legacy-read-canary', () => ({
  canaryGetSession: vi.fn(),
  canaryListSessions: vi.fn()
}))

import { updateSession } from '../../src/main/db/sessions-dao'

beforeEach(() => {
  state.updateSession.mockReset()
  state.routeGuard.mockReset()
})

it('ignores empty session patches instead of issuing a failing database update', async () => {
  await expect(updateSession('session-1', 'local-personal', {})).resolves.toBeUndefined()
  expect(state.updateSession).not.toHaveBeenCalled()
  expect(state.routeGuard).not.toHaveBeenCalled()
})

it('treats an updatedAt-only patch as a no-op', async () => {
  await expect(
    updateSession('session-1', 'local-personal', { updatedAt: 123 })
  ).resolves.toBeUndefined()
  expect(state.updateSession).not.toHaveBeenCalled()
})

it('persists explicit false and null values in session patches', async () => {
  await updateSession('session-1', 'local-personal', { pinned: false, workingFolder: null })
  expect(state.updateSession).toHaveBeenCalledWith({
    id: 'session-1',
    pinned: false,
    workingFolder: null,
    workspaceId: 'local-personal',
    updatedAt: expect.any(Number)
  })
})
