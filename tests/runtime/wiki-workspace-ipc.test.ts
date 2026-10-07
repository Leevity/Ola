import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('../../src/main/renderer-security', () => ({
  assertTrustedRendererIpcEvent: () => undefined,
  isTrustedRendererIpcEvent: () => true,
  registerTrustedRendererUrl: () => undefined
}))

const state = vi.hoisted(() => {
  const sender = { mainFrame: {} }
  const window = { isDestroyed: () => false, webContents: sender }
  return {
    sender,
    window,
    handlers: new Map<string, (event: unknown, args: unknown) => Promise<unknown>>(),
    registeredWorkspaceId: 'team-a',
    available: new Set(['team-a']),
    revokeDuringRead: false,
    reads: [] as Array<{ projectRoot: string; workspaceId: string }>,
    saves: [] as Array<{ projectRoot: string; workspaceId: string }>,
    deletes: [] as Array<{ projectRoot: string; workspaceId: string }>
  }
})

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (value: unknown) => (value === state.sender ? state.window : null)
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => Promise<unknown>) => {
      state.handlers.set(channel, handler)
    }
  }
}))
vi.mock('../../src/main/window-ipc', () => ({
  getRegisteredWindowWorkspace: () => state.registeredWorkspaceId
}))
vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: async () => state.available
}))
vi.mock('../../src/main/db/capability-dao', () => ({
  loadWikiDocument: async (projectRoot: string, workspaceId: string) => {
    state.reads.push({ projectRoot, workspaceId })
    if (state.revokeDuringRead) state.available = new Set()
    return { id: 'wiki-a', projectRoot, generatedAt: 1, fileCount: 0, nodes: [] }
  },
  saveWikiDocument: async (document: { projectRoot: string }, workspaceId: string) => {
    state.saves.push({ projectRoot: document.projectRoot, workspaceId })
  },
  deleteWikiDocument: async (projectRoot: string, workspaceId: string) => {
    state.deletes.push({ projectRoot, workspaceId })
  }
}))
vi.mock('../../src/main/wiki/wiki-service', () => ({
  generateProjectWiki: () => ({ id: 'wiki-a', projectRoot: '/project', nodes: [] }),
  loadProjectWiki: () => null,
  validateProjectRoot: (projectRoot: string) => {
    return projectRoot.startsWith('/') ? projectRoot : `/resolved/${projectRoot}`
  },
  writeProjectWikiMarkdown: () => undefined
}))
import { registerWikiHandlers } from '../../src/main/ipc/wiki-handlers'

const event = { sender: state.sender, senderFrame: state.sender.mainFrame }

beforeEach(() => {
  state.handlers.clear()
  state.registeredWorkspaceId = 'team-a'
  state.available = new Set(['team-a'])
  state.revokeDuringRead = false
  state.reads = []
  state.saves = []
  state.deletes = []
  registerWikiHandlers()
})

it('reads only the Wiki scope registered to the sending window', async () => {
  const get = state.handlers.get('wiki:get')!
  await expect(
    get(event, { projectRoot: '/project', workspaceId: 'team-a' })
  ).resolves.toMatchObject({
    id: 'wiki-a'
  })
  expect(state.reads).toEqual([{ projectRoot: '/project', workspaceId: 'team-a' }])
  await expect(
    get(event, { projectRoot: '/project', workspaceId: 'local-personal' })
  ).rejects.toThrow('WIKI_WORKSPACE_UNAVAILABLE')
  expect(state.reads).toHaveLength(1)
  await get(event, { projectRoot: 'workspace-wiki:forged', workspaceId: 'team-a' })
  expect(state.reads[1]).toEqual({
    projectRoot: '/resolved/workspace-wiki:forged',
    workspaceId: 'team-a'
  })
})

it('does not return a Wiki after team authorization is revoked during its read', async () => {
  state.revokeDuringRead = true
  const get = state.handlers.get('wiki:get')!
  await expect(get(event, { projectRoot: '/project', workspaceId: 'team-a' })).rejects.toThrow(
    'CHANNEL_WORKSPACE_UNAVAILABLE'
  )
  expect(state.reads).toHaveLength(1)
})

it('persists generated Wiki documents through the workspace-scoped TS DAO', async () => {
  const generate = state.handlers.get('wiki:generate')!
  await expect(
    generate(event, { projectRoot: '/project', workspaceId: 'team-a' })
  ).resolves.toMatchObject({ id: 'wiki-a' })
  expect(state.saves).toEqual([{ projectRoot: '/project', workspaceId: 'team-a' }])
})

it('deletes Wiki documents through the workspace-scoped TS DAO', async () => {
  const remove = state.handlers.get('wiki:delete')!
  await expect(remove(event, { projectRoot: '/project', workspaceId: 'team-a' })).resolves.toEqual({
    success: true
  })
  expect(state.deletes).toEqual([{ projectRoot: '/project', workspaceId: 'team-a' }])
  await expect(
    remove(event, { projectRoot: '/project', workspaceId: 'local-personal' })
  ).rejects.toThrow('WIKI_WORKSPACE_UNAVAILABLE')
})
