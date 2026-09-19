import { expect, it, vi } from 'vitest'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../src/shared/messagepack/binary-ipc'

const state = vi.hoisted(() => ({
  granted: true,
  release: null as ((value: unknown[]) => void) | null,
  handlers: new Map<string, (_event: unknown, bytes: Uint8Array) => Promise<Uint8Array>>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (_event: unknown, bytes: Uint8Array) => Promise<Uint8Array>
    ) => state.handlers.set(channel, handler)
  }
}))
vi.mock('../../src/main/db/sessions-dao', () => ({
  getSession: async () => ({ workspace_id: 'team-a' })
}))
vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: async () => new Set(state.granted ? ['team-a'] : [])
}))
vi.mock('../../src/main/db/agent-changes-dao', () => ({
  deleteStoredFinalizedRunChangeSetsOlderThan: async () => undefined,
  listStoredRunChangeSetsBySession: async () =>
    await new Promise<unknown[]>((resolve) => {
      state.release = resolve
    }),
  getStoredRunChangeSet: async () => null
}))

import { registerAgentChangeHandlers } from '../../src/main/ipc/agent-change-handlers'

it('does not return change snapshots after team authorization is revoked during a read', async () => {
  registerAgentChangeHandlers()
  const handler = state.handlers.get(toMessagePackChannel('agent:changes:list-session'))
  expect(handler).toBeDefined()
  const response = handler!(
    null,
    encodeMessagePackPayload({ sessionId: 'team-session', workspaceId: 'team-a' })
  )
  await expect.poll(() => state.release).toBeTypeOf('function')
  state.granted = false
  const release = state.release as ((value: unknown[]) => void) | null
  release?.([{ runId: 'private-run', changes: [] }])
  const result = decodeMessagePackPayload<{ error: string }>(await response)
  expect(result.error).toContain('agent-change-workspace-unavailable')
})
