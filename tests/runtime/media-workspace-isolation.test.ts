import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VideoTask } from '../../src/shared/media-runtime'

const state = vi.hoisted(() => ({
  root: '',
  workspace: 'local-personal' as string | null,
  handlers: new Map<string, (args: unknown, event: unknown) => Promise<unknown>>(),
  protocol: undefined as undefined | ((request: { url: string }) => Promise<Response>),
  index: vi.fn(async () => undefined),
  frame: {},
  window: {} as Record<string, unknown>,
  sender: {} as Record<string, unknown>
}))
vi.mock('electron', () => ({
  app: { getPath: () => state.root },
  BrowserWindow: { fromWebContents: () => state.window },
  protocol: {
    handle: (_name: string, handler: typeof state.protocol) => {
      state.protocol = handler
    }
  }
}))
vi.mock('../../src/main/window-ipc', () => ({
  getRegisteredWindowWorkspace: () => state.workspace
}))
vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: async () => new Set(['team-a'])
}))
vi.mock('../../src/main/db/sessions-dao', () => ({
  getSession: async (id: string) => (id === 'session' ? { id, project_id: 'project' } : null)
}))
vi.mock('../../src/main/db/projects-dao', () => ({ getProject: async () => null }))
vi.mock('../../src/main/runtime/desktop-runtime', () => ({
  desktopRuntime: { recordExternalArtifact: state.index }
}))
vi.mock('../../src/main/providers/provider-main-store', () => ({
  listMainProviderModels: async () => [],
  resolveMainProviderModel: () => ({ provider: { type: 'seedance-video' }, model: {} })
}))
vi.mock('../../src/main/media/seedance-video-adapter', () => ({
  createSeedanceTask: async () => 'remote',
  cancelSeedanceTask: async () => undefined,
  getSeedanceTaskStatus: async () => ({ state: 'running' }),
  downloadVideoResult: vi.fn()
}))
vi.mock('../../src/main/ipc/messagepack-handler', () => ({
  registerMessagePackHandler: (
    channel: string,
    handler: (args: unknown, event: unknown) => Promise<unknown>
  ) => state.handlers.set(channel, handler)
}))
const event = () => ({ sender: state.sender, senderFrame: state.frame })
async function invoke(channel: string, args: unknown = {}) {
  return await state.handlers.get(channel)!(args, event())
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  state.root = await mkdtemp(join(tmpdir(), 'ola-media-space-'))
  state.workspace = 'local-personal'
  state.handlers.clear()
  state.index.mockClear()
  state.sender = { mainFrame: state.frame }
  state.window = { isDestroyed: () => false, webContents: state.sender }
  await mkdir(join(state.root, 'media-cache'))
  await writeFile(join(state.root, 'media-cache', 'personal.mp4'), 'video')
  await writeFile(
    join(state.root, 'media-tasks.json'),
    JSON.stringify([
      {
        id: 'personal',
        providerId: 'provider',
        model: 'video',
        state: 'completed',
        outputUrl: 'personal.mp4'
      },
      { id: 'team', workspaceId: 'team-a', state: 'queued' }
    ])
  )
  const { registerMediaRuntimeHandlers } = await import('../../src/main/ipc/media-runtime-handlers')
  registerMediaRuntimeHandlers()
})
afterEach(async () => {
  vi.clearAllTimers()
  vi.useRealTimers()
  await rm(state.root, { recursive: true, force: true })
})
describe('media workspace isolation', () => {
  it('migrates old tasks to personal and prevents cross-space cancel or delete', async () => {
    const personal = (await invoke('media:tasks-list')) as VideoTask[]
    expect(personal.map((task) => task.id)).toEqual(['personal'])
    expect(state.index).toHaveBeenCalledTimes(1)
    await invoke('media:tasks-list')
    expect(state.index).toHaveBeenCalledTimes(1)
    state.workspace = 'team-a'
    expect(((await invoke('media:tasks-list')) as VideoTask[]).map((task) => task.id)).toEqual([
      'team'
    ])
    expect(await invoke('media:task-cancel', { id: 'personal' })).toEqual({ success: false })
    expect(await invoke('media:task-delete', { id: 'personal' })).toEqual({ success: false })
    expect(await readFile(join(state.root, 'media-cache', 'personal.mp4'), 'utf8')).toBe('video')
  })
  it('requires an authorized window and makes preview capabilities invalid after switching spaces', async () => {
    const [task] = (await invoke('media:tasks-list')) as VideoTask[]
    expect((await state.protocol!({ url: 'ola-media://personal' })).status).toBe(404)
    expect((await state.protocol!({ url: task.previewUrl! })).status).toBe(200)
    state.workspace = 'team-a'
    expect((await state.protocol!({ url: task.previewUrl! })).status).toBe(404)
    state.workspace = null
    await expect(invoke('media:tasks-list')).rejects.toThrow('not registered')
    state.workspace = 'unauthorized'
    await expect(invoke('media:tasks-list')).rejects.toThrow('unavailable')
  })
  it('persists separate plugin settings and binds source session ownership in Main', async () => {
    await invoke('media:settings-update', { videoGenerationEnabled: true })
    state.workspace = 'team-a'
    expect(
      ((await invoke('media:status')) as { settings: { videoGenerationEnabled: boolean } }).settings
        .videoGenerationEnabled
    ).toBe(false)
    state.workspace = 'local-personal'
    const request = {
      provider: 'seedance',
      providerId: 'provider',
      model: 'video',
      prompt: 'video',
      sessionId: 'session'
    }
    const task = (await invoke('media:task-create', request)) as VideoTask
    expect(task.workspaceId).toBe('local-personal')
    expect(task.sessionId).toBe('session')
    expect(task.projectId).toBe('project')
    await expect(
      invoke('media:task-create', { ...request, sessionId: 'other-space-session' })
    ).rejects.toThrow('unavailable')
    await invoke('media:settings-update', { videoGenerationEnabled: false })
  })
})
