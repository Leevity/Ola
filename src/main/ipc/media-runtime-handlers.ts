import { app, protocol } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  MEDIA_CACHE_MAX_BYTES,
  MEDIA_FILE_MAX_BYTES,
  type MediaPluginSettings,
  type VideoGenerationRequest,
  type VideoTask
} from '../../shared/media-runtime'
import { registerMessagePackHandler } from './messagepack-handler'

const tasks = new Map<string, VideoTask>()
const settings: MediaPluginSettings = {
  videoGenerationEnabled: false,
  seedanceEnabled: false,
  xaiEnabled: false
}
let protocolRegistered = false
let tasksLoaded = false
const cacheDir = (): string => path.join(app.getPath('userData'), 'media-cache')
const tasksPath = (): string => path.join(app.getPath('userData'), 'media-tasks.json')

async function loadTasks(): Promise<void> {
  if (tasksLoaded) return
  tasksLoaded = true
  try {
    const parsed = JSON.parse(await fs.readFile(tasksPath(), 'utf8')) as VideoTask[]
    for (const task of parsed) {
      if (!task?.id) continue
      tasks.set(task.id, task.state === 'running' ? { ...task, state: 'queued' } : task)
    }
  } catch {
    // A missing or invalid task index starts clean; cached media remains untouched.
  }
}

async function persistTasks(): Promise<void> {
  const filePath = tasksPath()
  const tempPath = `${filePath}.tmp`
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(tempPath, JSON.stringify(Array.from(tasks.values())), 'utf8')
  await fs.rename(tempPath, filePath)
}

function validateVideoRequest(input: VideoGenerationRequest): VideoGenerationRequest {
  const prompt = input.prompt?.trim()
  if (!prompt) throw new Error('Video prompt is required')
  if (input.durationSeconds !== undefined && input.durationSeconds <= 0) {
    throw new Error('Video duration must be greater than zero')
  }
  for (const value of [input.firstFrameUrl, input.lastFrameUrl]) {
    if (!value) continue
    const protocol = new URL(value).protocol
    if (!['file:', 'ola-media:', 'data:'].includes(protocol)) {
      throw new Error('Video frame input uses an unsupported protocol')
    }
  }
  return { ...input, prompt }
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
      return new Response(await fs.readFile(filePath), {
        headers: { 'content-type': 'video/mp4', 'cache-control': 'no-store' }
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
    return { settings, ...(await cleanupCache()), maxBytes: MEDIA_CACHE_MAX_BYTES }
  })
  registerMessagePackHandler<Partial<MediaPluginSettings>>(
    'media:settings-update',
    async (input) => {
      if (typeof input.videoGenerationEnabled === 'boolean') {
        settings.videoGenerationEnabled = input.videoGenerationEnabled
      }
      if (typeof input.seedanceEnabled === 'boolean')
        settings.seedanceEnabled = input.seedanceEnabled
      if (typeof input.xaiEnabled === 'boolean') settings.xaiEnabled = input.xaiEnabled
      return { ...settings }
    }
  )
  registerMessagePackHandler('media:tasks-list', async () => {
    await loadTasks()
    return Array.from(tasks.values())
  })
  registerMessagePackHandler<VideoGenerationRequest>('media:task-create', async (rawInput) => {
    await loadTasks()
    if (!settings.videoGenerationEnabled) throw new Error('Video generation is disabled')
    const input = validateVideoRequest(rawInput)
    const enabled = input.provider === 'seedance' ? settings.seedanceEnabled : settings.xaiEnabled
    if (!enabled) throw new Error('Optional video provider plugin is disabled')
    const now = Date.now()
    const task: VideoTask = {
      id: randomUUID(),
      provider: input.provider,
      prompt: input.prompt,
      request: input,
      state: 'queued',
      estimatedCostUsd: null,
      progress: 0,
      createdAt: now,
      updatedAt: now
    }
    tasks.set(task.id, task)
    await persistTasks()
    return task
  })
  registerMessagePackHandler<{ id: string }>('media:task-cancel', async ({ id }) => {
    await loadTasks()
    const task = tasks.get(id)
    if (task && task.state !== 'completed')
      tasks.set(id, { ...task, state: 'cancelled', updatedAt: Date.now() })
    await persistTasks()
    return { success: Boolean(task) }
  })
  registerMessagePackHandler<{ id: string }>('media:task-delete', async ({ id }) => {
    await loadTasks()
    const success = tasks.delete(id)
    await persistTasks()
    return { success }
  })
  registerMessagePackHandler('media:cache-cleanup', cleanupCache)
}
