import { app, protocol } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
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
import { registerMessagePackHandler } from './messagepack-handler'

interface PersistedVideoTask extends VideoTask {
  remoteTaskId?: string
  pollFailures?: number
}

const POLL_BASE_MS = 4_000
const POLL_MAX_MS = 30_000
const MAX_POLL_FAILURES = 6
const tasks = new Map<string, PersistedVideoTask>()
const controllers = new Map<string, AbortController>()
const settings: MediaPluginSettings = { videoGenerationEnabled: false }
let protocolRegistered = false
let tasksLoaded = false
let persistQueue = Promise.resolve()
const cacheDir = (): string => path.join(app.getPath('userData'), 'media-cache')
const tasksPath = (): string => path.join(app.getPath('userData'), 'media-tasks.json')

function publicTask(task: PersistedVideoTask): VideoTask {
  const { remoteTaskId: _remoteTaskId, pollFailures: _pollFailures, ...value } = task
  return value
}

async function loadTasks(): Promise<void> {
  if (tasksLoaded) return
  tasksLoaded = true
  try {
    const parsed = JSON.parse(await fs.readFile(tasksPath(), 'utf8')) as PersistedVideoTask[]
    for (const task of parsed) {
      if (!task?.id) continue
      if (task.state === 'running' && !task.remoteTaskId) {
        task.state = 'failed'
        task.error = 'The application stopped before the provider accepted this task. Retry it.'
      }
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
      await fs.writeFile(tempPath, JSON.stringify(Array.from(tasks.values())), { mode: 0o600 })
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

function capabilities(): VideoProviderCapability[] {
  return listMainProviderModels('seedance-video').map((entry) => ({
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

async function cleanupCache(): Promise<{ bytes: number; removed: number }> {
  const entries = (await cacheEntries())
    .filter((entry) => entry.size > 0)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
  let bytes = entries.reduce((sum, entry) => sum + entry.size, 0)
  let removed = 0
  for (const entry of entries) {
    if (bytes <= MEDIA_CACHE_MAX_BYTES) break
    await fs.rm(entry.path, { force: true })
    bytes -= entry.size
    removed += 1
  }
  return { bytes, removed }
}

function updateTask(task: PersistedVideoTask, patch: Partial<PersistedVideoTask>): void {
  Object.assign(task, patch, { updatedAt: Date.now() })
  tasks.set(task.id, task)
  void persistTasks().catch((error) => console.error('[Media] Failed to persist task state', error))
}

function schedulePoll(task: PersistedVideoTask, delayMs: number): void {
  if (
    !settings.videoGenerationEnabled ||
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
      updateTask(task, {
        state: 'completed',
        progress: 100,
        outputUrl: output.fileName,
        outputBytes: output.bytes,
        error: undefined,
        pollFailures: 0
      })
      await cleanupCache()
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
    updateTask(task, { remoteTaskId, state: 'queued', progress: 0 })
  } catch (error) {
    if (controller.signal.aborted) return
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
  if (!settings.videoGenerationEnabled) return
  await loadTasks()
  for (const task of tasks.values()) {
    if (task.remoteTaskId && (task.state === 'queued' || task.state === 'running')) {
      schedulePoll(task, 0)
    }
  }
}

function registerLocalMediaProtocol(): void {
  if (protocolRegistered) return
  protocolRegistered = true
  protocol.handle('ola-media', async (request) => {
    const task = tasks.get(new URL(request.url).hostname)
    if (!task?.outputUrl) return new Response('Not found', { status: 404 })
    const root = path.resolve(cacheDir())
    const filePath = path.resolve(root, path.basename(task.outputUrl))
    if (!filePath.startsWith(`${root}${path.sep}`))
      return new Response('Forbidden', { status: 403 })
    try {
      const stat = await fs.stat(filePath)
      if (stat.size > MEDIA_FILE_MAX_BYTES)
        return new Response('Media file exceeds limit', { status: 413 })
      const mediaType = path.extname(filePath) === '.webm' ? 'video/webm' : 'video/mp4'
      return new Response(await fs.readFile(filePath), {
        headers: { 'content-type': mediaType, 'cache-control': 'no-store' }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

export function registerMediaRuntimeHandlers(): void {
  registerLocalMediaProtocol()
  registerMessagePackHandler('media:status', async () => {
    await loadTasks()
    return {
      settings,
      capabilities: capabilities(),
      ...(await cleanupCache()),
      maxBytes: MEDIA_CACHE_MAX_BYTES
    }
  })
  registerMessagePackHandler<Partial<MediaPluginSettings>>(
    'media:settings-update',
    async (input) => {
      if (typeof input.videoGenerationEnabled === 'boolean') {
        settings.videoGenerationEnabled = input.videoGenerationEnabled
        if (!input.videoGenerationEnabled) {
          for (const controller of controllers.values()) controller.abort()
          controllers.clear()
        } else {
          void resumeTasks()
        }
      }
      return { ...settings }
    }
  )
  registerMessagePackHandler('media:tasks-list', async () => {
    await loadTasks()
    return Array.from(tasks.values(), publicTask)
  })
  registerMessagePackHandler<VideoGenerationRequest>('media:task-create', async (rawInput) => {
    await loadTasks()
    if (!settings.videoGenerationEnabled) throw new Error('Video generation is disabled')
    const input = validateVideoRequest(rawInput)
    const now = Date.now()
    const task: PersistedVideoTask = {
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
    return publicTask(task)
  })
  registerMessagePackHandler<{ id: string }>('media:task-cancel', async ({ id }) => {
    await loadTasks()
    const task = tasks.get(id)
    if (!task) return { success: false }
    controllers.get(id)?.abort()
    controllers.delete(id)
    if (task.remoteTaskId && !['completed', 'failed', 'cancelled'].includes(task.state)) {
      const controller = new AbortController()
      await cancelSeedanceTask(resolveTaskProvider(task), task.remoteTaskId, controller.signal)
    }
    updateTask(task, { state: 'cancelled' })
    await persistTasks()
    return { success: true }
  })
  registerMessagePackHandler<{ id: string }>('media:task-delete', async ({ id }) => {
    await loadTasks()
    const task = tasks.get(id)
    if (task && !['completed', 'failed', 'cancelled'].includes(task.state)) {
      throw new Error('Cancel an active video task before deleting it')
    }
    const success = tasks.delete(id)
    if (task?.outputUrl)
      await fs.rm(path.join(cacheDir(), path.basename(task.outputUrl)), { force: true })
    await persistTasks()
    return { success }
  })
  registerMessagePackHandler('media:cache-cleanup', cleanupCache)
}
