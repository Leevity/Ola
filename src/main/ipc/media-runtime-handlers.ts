import { app, BrowserWindow, protocol, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getRegisteredWindowWorkspace } from '../window-ipc'
import { authorizeDbWorkspace } from './db-workspace-authorization'
import { loadOfflineWorkspaceIds } from '../remote/account-client'
import { getProject } from '../db/projects-dao'
import { getSession } from '../db/sessions-dao'
import { desktopRuntime } from '../runtime/desktop-runtime'
import {
  MEDIA_CACHE_MAX_BYTES,
  MEDIA_FILE_MAX_BYTES,
  type MediaPluginSettings,
  type VideoGenerationRequest,
  type VideoProviderCapability,
  type VideoTask
} from '../../shared/media-runtime'
import { listMainProviderModels, resolveMainProviderModel } from '../providers/provider-main-store'
import {
  cancelSeedanceTask,
  createSeedanceTask,
  downloadVideoResult,
  getSeedanceTaskStatus
} from '../media/seedance-video-adapter'
import { registerMessagePackHandler as registerRawMessagePackHandler } from './messagepack-handler'

interface PersistedVideoTask extends VideoTask {
  remoteTaskId?: string
  pollFailures?: number
  artifactRegistered?: boolean
}

const POLL_BASE_MS = 4_000
const POLL_MAX_MS = 30_000
const MAX_POLL_FAILURES = 6
const tasks = new Map<string, PersistedVideoTask>()
const controllers = new Map<string, AbortController>()
const workspaceSettings = new Map<string, MediaPluginSettings>()
const settingsFor = (workspaceId: string): MediaPluginSettings => {
  if (!workspaceSettings.has(workspaceId))
    workspaceSettings.set(workspaceId, { videoGenerationEnabled: false })
  return workspaceSettings.get(workspaceId)!
}
const previews = new Map<string, { window: BrowserWindow; workspaceId: string; taskId: string }>()
async function workspace(event: IpcMainInvokeEvent): Promise<string> {
  const win = BrowserWindow.fromWebContents(event.sender)
  const id = win ? getRegisteredWindowWorkspace(win) : null
  if (!id) throw new Error('Media workspace is not registered')
  await authorizeDbWorkspace(id, loadOfflineWorkspaceIds, id)
  if (!win || getRegisteredWindowWorkspace(win) !== id) throw new Error('Media workspace changed')
  return id
}
let protocolRegistered = false
let taskLoading: Promise<void> | undefined
let persistQueue = Promise.resolve()
const cacheDir = (): string => path.join(app.getPath('userData'), 'media-cache')
const tasksPath = (): string => path.join(app.getPath('userData'), 'media-tasks.json')

function registerMessagePackHandler<TArgs, TResult = unknown>(
  channel: string,
  handler: (args: TArgs, event: IpcMainInvokeEvent) => Promise<TResult> | TResult
): void {
  registerRawMessagePackHandler<TArgs, TResult>(channel, async (args, event) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender)
    if (
      !ownerWindow ||
      ownerWindow.isDestroyed() ||
      ownerWindow.webContents !== event.sender ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new Error('Unauthorized media IPC sender')
    }
    const id = await workspace(event)
    const result = await handler(args, event)
    if (getRegisteredWindowWorkspace(ownerWindow) !== id) throw new Error('Media workspace changed')
    return result
  })
}

function publicTask(task: PersistedVideoTask, event: IpcMainInvokeEvent): VideoTask {
  const { remoteTaskId: _remoteTaskId, pollFailures: _pollFailures, ...value } = task
  if (task.outputUrl) {
    const win = BrowserWindow.fromWebContents(event.sender)!
    let token = [...previews].find(
      ([, grant]) => grant.window === win && grant.taskId === task.id
    )?.[0]
    if (!token) {
      token = randomUUID()
      if (previews.size >= 1024) previews.delete(previews.keys().next().value!)
      previews.set(token, { window: win, workspaceId: task.workspaceId!, taskId: task.id })
    }
    value.previewUrl = `ola-media://${token}`
  }
  return value
}

function loadTasks(): Promise<void> {
  return (taskLoading ??= readTasks())
}
async function readTasks(): Promise<void> {
  try {
    const parsed = JSON.parse(await fs.readFile(tasksPath(), 'utf8'))
    const saved: PersistedVideoTask[] = Array.isArray(parsed) ? parsed : (parsed.tasks ?? [])
    for (const [id, setting] of Object.entries(parsed.settings ?? {}))
      workspaceSettings.set(id, setting as MediaPluginSettings)
    for (const task of saved) {
      if (!task?.id) continue
      if (task.state === 'running' && !task.remoteTaskId) {
        task.state = 'failed'
        task.error = 'The application stopped before the provider accepted this task. Retry it.'
      }
      task.workspaceId ??= 'local-personal'
      tasks.set(task.id, task)
    }
  } catch {
    // A missing or invalid task index starts clean; cached media remains untouched.
  }
}

async function persistTasks(): Promise<void> {
  persistQueue = persistQueue
    .catch(() => undefined)
    .then(async () => {
      const filePath = tasksPath()
      const tempPath = `${filePath}.tmp`
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(
        tempPath,
        JSON.stringify({
          version: 1,
          tasks: Array.from(tasks.values()),
          settings: Object.fromEntries(workspaceSettings)
        }),
        { mode: 0o600 }
      )
      await fs.rename(tempPath, filePath)
    })
  return persistQueue
}

function resolveTaskProvider(task: PersistedVideoTask) {
  const resolved = resolveMainProviderModel(task.providerId, task.model)
  if (!resolved) throw new Error('Configured video provider or model is unavailable')
  const requestType = resolved.model.type ?? resolved.provider.type
  if (task.provider !== 'seedance' || requestType !== 'seedance-video') {
    throw new Error('Configured model does not support Seedance video generation')
  }
  return { provider: resolved.provider, request: task.request! }
}

async function capabilities(): Promise<VideoProviderCapability[]> {
  return (await listMainProviderModels('seedance-video')).map((entry) => ({
    provider: 'seedance',
    providerId: entry.providerId,
    providerName: entry.providerName,
    enabled: true,
    models: [entry.modelId],
    supportsFirstFrame: true,
    supportsLastFrame: true,
    aspectRatios: ['16:9', '9:16', '1:1', 'adaptive'],
    durationsSeconds: [5, 10],
    resolutions: ['720p', '1080p']
  }))
}

function validateVideoRequest(input: VideoGenerationRequest): VideoGenerationRequest {
  const prompt = input.prompt?.trim()
  if (!prompt) throw new Error('Video prompt is required')
  if (!input.providerId?.trim()) throw new Error('Video provider is required')
  if (!input.model?.trim()) throw new Error('Video model is required')
  if (input.durationSeconds !== undefined && ![5, 10].includes(input.durationSeconds)) {
    throw new Error('This video model supports 5 or 10 second clips')
  }
  if (input.aspectRatio && !['16:9', '9:16', '1:1', 'adaptive'].includes(input.aspectRatio)) {
    throw new Error('Unsupported video aspect ratio')
  }
  if (input.resolution && !['720p', '1080p'].includes(input.resolution)) {
    throw new Error('Unsupported video resolution')
  }
  for (const value of [input.firstFrameUrl, input.lastFrameUrl]) {
    if (!value) continue
    const inputProtocol = new URL(value).protocol
    if (!['https:', 'data:'].includes(inputProtocol)) {
      throw new Error('Video frame input must use HTTPS or an image data URL')
    }
  }
  return { ...input, providerId: input.providerId.trim(), model: input.model.trim(), prompt }
}

async function cacheEntries(): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  try {
    const names = await fs.readdir(cacheDir())
    return await Promise.all(
      names.map(async (name) => {
        const filePath = path.join(cacheDir(), name)
        const stat = await fs.stat(filePath)
        return { path: filePath, size: stat.isFile() ? stat.size : 0, mtimeMs: stat.mtimeMs }
      })
    )
  } catch {
    return []
  }
}

async function cleanupCache(workspaceId: string): Promise<{ bytes: number; removed: number }> {
  const entries = (await cacheEntries())
    .filter(
      (entry) =>
        entry.size > 0 &&
        [...tasks.values()].some(
          (task) => task.workspaceId === workspaceId && task.outputUrl === path.basename(entry.path)
        )
    )
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
  let bytes = entries.reduce((sum, entry) => sum + entry.size, 0)
  let removed = 0
  for (const entry of entries) {
    if (bytes <= MEDIA_CACHE_MAX_BYTES) break
    await fs.rm(entry.path, { force: true })
    const removedName = path.basename(entry.path)
    for (const task of tasks.values()) {
      if (task.outputUrl === removedName) {
        task.outputUrl = undefined
        task.outputBytes = undefined
        task.updatedAt = Date.now()
      }
    }
    bytes -= entry.size
    removed += 1
  }
  if (removed > 0) await persistTasks()
  return { bytes, removed }
}

function updateTask(task: PersistedVideoTask, patch: Partial<PersistedVideoTask>): void {
  Object.assign(task, patch, { updatedAt: Date.now() })
  tasks.set(task.id, task)
  void persistTasks().catch((error) => console.error('[Media] Failed to persist task state', error))
}

function schedulePoll(task: PersistedVideoTask, delayMs: number): void {
  if (
    !settingsFor(task.workspaceId!).videoGenerationEnabled ||
    controllers.has(task.id) ||
    ['completed', 'failed', 'cancelled'].includes(task.state)
  )
    return
  const controller = new AbortController()
  controllers.set(task.id, controller)
  const timer = setTimeout(() => void pollTask(task, controller), delayMs)
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
}

async function pollTask(task: PersistedVideoTask, controller: AbortController): Promise<void> {
  try {
    await authorizeDbWorkspace(task.workspaceId, loadOfflineWorkspaceIds)
    if (!task.remoteTaskId) throw new Error('Video provider task identifier is missing')
    const status = await getSeedanceTaskStatus(
      resolveTaskProvider(task),
      task.remoteTaskId,
      controller.signal
    )
    if (status.state === 'completed') {
      if (!status.outputUrl) throw new Error('Video provider completed without an output URL')
      const output = await downloadVideoResult(
        status.outputUrl,
        cacheDir(),
        task.id,
        controller.signal
      )
      controller.signal.throwIfAborted()
      if (task.state === 'cancelled') return
      updateTask(task, {
        state: 'completed',
        progress: 100,
        outputUrl: output.fileName,
        outputBytes: output.bytes,
        error: undefined,
        pollFailures: 0
      })
      await registerResult(task)
      await cleanupCache(task.workspaceId!)
      return
    }
    if (status.state === 'failed' || status.state === 'cancelled') {
      updateTask(task, { state: status.state, error: status.error, progress: status.progress })
      return
    }
    updateTask(task, { state: status.state, progress: status.progress, pollFailures: 0 })
    controllers.delete(task.id)
    schedulePoll(task, POLL_BASE_MS)
  } catch (error) {
    if (controller.signal.aborted) {
      if (!task.remoteTaskId) {
        updateTask(task, {
          state: 'failed',
          error: 'Video submission was interrupted before a provider task was confirmed.'
        })
      }
      return
    }
    const failures = (task.pollFailures ?? 0) + 1
    if (failures >= MAX_POLL_FAILURES) {
      updateTask(task, {
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
        pollFailures: failures
      })
      return
    }
    updateTask(task, { pollFailures: failures })
    controllers.delete(task.id)
    schedulePoll(task, Math.min(POLL_MAX_MS, POLL_BASE_MS * 2 ** failures))
  } finally {
    if (controllers.get(task.id) === controller) controllers.delete(task.id)
  }
}

async function startTask(task: PersistedVideoTask): Promise<void> {
  const controller = new AbortController()
  controllers.set(task.id, controller)
  try {
    updateTask(task, { state: 'running', error: undefined })
    const remoteTaskId = await createSeedanceTask(resolveTaskProvider(task), controller.signal)
    controller.signal.throwIfAborted()
    updateTask(task, { remoteTaskId, state: 'queued', progress: 0 })
  } catch (error) {
    if (controller.signal.aborted) {
      if (task.state !== 'cancelled')
        updateTask(task, {
          state: 'failed',
          error: 'Video submission was interrupted before confirmation. Retry it.'
        })
      return
    }
    updateTask(task, {
      state: 'failed',
      error: error instanceof Error ? error.message : String(error)
    })
    return
  } finally {
    controllers.delete(task.id)
  }
  schedulePoll(task, POLL_BASE_MS)
}

async function resumeTasks(): Promise<void> {
  await loadTasks()
  for (const task of tasks.values()) {
    if (task.remoteTaskId && (task.state === 'queued' || task.state === 'running')) {
      schedulePoll(task, 0)
    }
  }
}

async function registerResult(task: PersistedVideoTask): Promise<void> {
  if (task.state !== 'completed' || !task.outputUrl || task.artifactRegistered) return
  try {
    const file = path.join(cacheDir(), path.basename(task.outputUrl))
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) return
    const id = `media-result-${task.id}`
    await desktopRuntime.recordExternalArtifact(
      {
        runId: id,
        taskId: id,
        requestId: id,
        traceId: id,
        sessionId: task.sessionId ?? id,
        projectId: task.projectId,
        workspaceId: task.workspaceId!,
        environmentId: 'local',
        modelSource: { kind: 'local', providerId: task.providerId, modelId: task.model },
        prompt: task.prompt,
        businessTaskTitle: (task.prompt ?? 'Video result').slice(0, 120),
        unattended: false
      },
      { path: file, mediaType: path.extname(file) === '.webm' ? 'video/webm' : 'video/mp4' }
    )
    task.artifactRegistered = true
    await persistTasks()
  } catch (error) {
    console.warn('[Media] Result indexing will retry', error)
  }
}

export async function getVideoCapabilitiesForWorkspace(
  workspaceId: string
): Promise<VideoProviderCapability[]> {
  await authorizeDbWorkspace(workspaceId, loadOfflineWorkspaceIds)
  await loadTasks()
  if (!settingsFor(workspaceId).videoGenerationEnabled)
    throw new Error('Video generation is disabled')
  return capabilities()
}

export async function createVideoTaskForWorkspace(
  rawInput: VideoGenerationRequest,
  workspaceId: string,
  assertCurrent?: () => Promise<void>
): Promise<VideoTask> {
  await authorizeDbWorkspace(workspaceId, loadOfflineWorkspaceIds)
  await loadTasks()
  if (!settingsFor(workspaceId).videoGenerationEnabled)
    throw new Error('Video generation is disabled')
  const input = validateVideoRequest(rawInput)
  const session = input.sessionId ? await getSession(input.sessionId, workspaceId) : undefined
  const project = input.projectId ? await getProject(input.projectId, workspaceId) : undefined
  if (input.projectId && !project) throw new Error('Video project is unavailable')
  if (project && session?.project_id && project.id !== session.project_id)
    throw new Error('Video project mismatch')
  if (input.sessionId && !session) throw new Error('Video source session is unavailable')
  await assertCurrent?.()
  const now = Date.now()
  const task: PersistedVideoTask = {
    workspaceId,
    sessionId: session?.id,
    projectId: session?.project_id ?? project?.id,
    id: randomUUID(),
    provider: input.provider,
    providerId: input.providerId,
    model: input.model,
    prompt: input.prompt,
    request: input,
    state: 'queued',
    estimatedCostUsd: null,
    progress: 0,
    createdAt: now,
    updatedAt: now
  }
  resolveTaskProvider(task)
  tasks.set(task.id, task)
  await persistTasks()
  void startTask(task)
  return { ...task, remoteTaskId: undefined } as VideoTask
}

function registerLocalMediaProtocol(): void {
  if (protocolRegistered) return
  protocolRegistered = true
  protocol.handle('ola-media', async (request) => {
    const grant = previews.get(new URL(request.url).hostname)
    if (!grant || getRegisteredWindowWorkspace(grant.window) !== grant.workspaceId)
      return new Response('Not found', { status: 404 })
    try {
      await authorizeDbWorkspace(grant.workspaceId, loadOfflineWorkspaceIds, grant.workspaceId)
    } catch {
      return new Response('Not found', { status: 404 })
    }
    const task = tasks.get(grant.taskId)
    if (task?.workspaceId !== grant.workspaceId || !task?.outputUrl)
      return new Response('Not found', { status: 404 })
    const root = path.resolve(cacheDir())
    const filePath = path.resolve(root, path.basename(task.outputUrl))
    if (!filePath.startsWith(`${root}${path.sep}`))
      return new Response('Forbidden', { status: 403 })
    try {
      const stat = await fs.lstat(filePath)
      if (!stat.isFile() || stat.isSymbolicLink()) return new Response('Not found', { status: 404 })
      if (stat.size > MEDIA_FILE_MAX_BYTES)
        return new Response('Media file exceeds limit', { status: 413 })
      const mediaType = path.extname(filePath) === '.webm' ? 'video/webm' : 'video/mp4'
      const data = await fs.readFile(filePath)
      if (getRegisteredWindowWorkspace(grant.window) !== grant.workspaceId)
        return new Response('Not found', { status: 404 })
      return new Response(data, {
        headers: { 'content-type': mediaType, 'cache-control': 'no-store' }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

export function registerMediaRuntimeHandlers(): void {
  registerLocalMediaProtocol()
  registerMessagePackHandler('media:status', async (_args, event) => {
    const workspaceId = await workspace(event)
    await loadTasks()
    return {
      settings: settingsFor(workspaceId),
      capabilities: await capabilities(),
      totalBytes: (await cleanupCache(workspaceId)).bytes,
      removedFiles: 0,
      maxBytes: MEDIA_CACHE_MAX_BYTES
    }
  })
  registerMessagePackHandler<Partial<MediaPluginSettings>>(
    'media:settings-update',
    async (input, event) => {
      await loadTasks()
      const workspaceId = await workspace(event)
      const settings = settingsFor(workspaceId)
      if (typeof input.videoGenerationEnabled === 'boolean') {
        settings.videoGenerationEnabled = input.videoGenerationEnabled
        if (!input.videoGenerationEnabled) {
          for (const [id, controller] of controllers) {
            if (tasks.get(id)?.workspaceId === workspaceId) {
              controller.abort()
              controllers.delete(id)
            }
          }
        } else {
          void resumeTasks()
        }
      }
      await persistTasks()
      return { ...settings }
    }
  )
  registerMessagePackHandler('media:tasks-list', async (_args, event) => {
    const workspaceId = await workspace(event)
    await loadTasks()
    const visible = [...tasks.values()].filter((task) => task.workspaceId === workspaceId)
    for (const task of visible)
      if (task.state === 'completed' && !task.artifactRegistered) await registerResult(task)
    void resumeTasks()
    return visible.map((task) => publicTask(task, event))
  })
  registerMessagePackHandler<VideoGenerationRequest>(
    'media:task-create',
    async (rawInput, event) => {
      const workspaceId = await workspace(event)
      const task = await createVideoTaskForWorkspace(rawInput, workspaceId, async () => {
        if ((await workspace(event)) !== workspaceId) throw new Error('Media workspace changed')
      })
      return publicTask(task, event)
    }
  )
  registerMessagePackHandler<{ id: string }>('media:task-cancel', async ({ id }, event) => {
    await loadTasks()
    const workspaceId = await workspace(event)
    const task = tasks.get(id)
    if (task && task.workspaceId !== workspaceId) return { success: false }
    if (!task) return { success: false }
    if (['completed', 'failed', 'cancelled'].includes(task.state)) return { success: false }
    controllers.get(id)?.abort()
    controllers.delete(id)
    if (task.remoteTaskId && !['completed', 'failed', 'cancelled'].includes(task.state)) {
      const controller = new AbortController()
      try {
        await cancelSeedanceTask(resolveTaskProvider(task), task.remoteTaskId, controller.signal)
      } catch (error) {
        updateTask(task, { error: 'Provider cancellation failed; task status will refresh.' })
        schedulePoll(task, 0)
        throw error
      }
    }
    if ((await workspace(event)) !== workspaceId) throw new Error('Media workspace changed')
    updateTask(task, { state: 'cancelled' })
    await persistTasks()
    return { success: true }
  })
  registerMessagePackHandler<{ id: string }>('media:task-delete', async ({ id }, event) => {
    await loadTasks()
    const workspaceId = await workspace(event)
    const task = tasks.get(id)
    if (task && task.workspaceId !== workspaceId) return { success: false }
    if (task && !['completed', 'failed', 'cancelled'].includes(task.state)) {
      throw new Error('Cancel an active video task before deleting it')
    }
    const success = tasks.delete(id)
    if (task?.outputUrl)
      await fs.rm(path.join(cacheDir(), path.basename(task.outputUrl)), { force: true })
    await persistTasks()
    return { success }
  })
  registerMessagePackHandler('media:cache-cleanup', async (_args, event) =>
    cleanupCache(await workspace(event))
  )
}
