import { beforeEach, expect, it, vi } from 'vitest'
import { decode, encode } from '@msgpack/msgpack'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>>(),
  sender: { mainFrame: {}, isDestroyed: () => false }
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>
    ) => state.handlers.set(channel, handler)
  }
}))
vi.mock('../../src/main/window-ipc', () => ({
  getTrustedWorkspaceRegistrationWindow: () => ({ webContents: state.sender }),
  getRegisteredWindowWorkspace: () => 'team-a'
}))
vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: async () => new Set(['team-a'])
}))
vi.mock('../../src/main/teams/team-runtime-store', () => ({
  TeamRuntimeStore: class {
    async create() {
      return { success: true, teamId: 'team-1' }
    }
    async delete() {
      return { success: true }
    }
    async appendMessage() {
      return { success: true, messageId: 'message-1' }
    }
    async snapshot() {
      return { team: { id: 'team-1', tasks: [] } }
    }
    async updateMember() {
      return { success: true }
    }
    async updateManifestPatch() {
      return { success: true }
    }
    async consumeMessages() {
      return { messages: [] }
    }
  }
}))

import { registerTeamRuntimeHandlers } from '../../src/main/ipc/team-runtime-handlers'

const event = { sender: state.sender, senderFrame: state.sender.mainFrame }
const args = { workspaceId: 'team-a', teamId: 'team-1' }

async function call<T>(channel: string, payload: unknown): Promise<T> {
  const handler = state.handlers.get(`${channel}:msgpack`)
  if (!handler) throw new Error(`missing handler: ${channel}`)
  return decode(await handler(event, encode(payload))) as T
}

beforeEach(() => {
  state.handlers.clear()
  registerTeamRuntimeHandlers()
})

it('routes the complete team runtime lifecycle through Main TS', async () => {
  await expect(call('team-runtime:create', args)).resolves.toMatchObject({ success: true })
  await expect(call('team-runtime:delete', args)).resolves.toEqual({ success: true })
  await expect(
    call('team-runtime:message:append', { ...args, content: 'hello' })
  ).resolves.toMatchObject({ success: true })
  await expect(call('team-runtime:snapshot', args)).resolves.toMatchObject({
    team: { id: 'team-1' }
  })
  await expect(call('team-runtime:member:update', args)).resolves.toEqual({ success: true })
  await expect(call('team-runtime:manifest:update', args)).resolves.toEqual({ success: true })
  await expect(call('team-runtime:messages:consume', args)).resolves.toEqual({ messages: [] })
  await expect(
    call('team-runtime:snapshot', { ...args, workspaceId: 'local-personal' })
  ).rejects.toThrow('TEAM_WORKSPACE_FORBIDDEN')
})
