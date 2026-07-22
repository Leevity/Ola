import { app, protocol } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  MEDIA_CACHE_MAX_BYTES,
  MEDIA_FILE_MAX_BYTES,
  type MediaPluginSettings,
  type VideoTask
} from '../../shared/media-runtime'
import { registerMessagePackHandler } from './messagepack-handler'

const tasks = new Map<string, VideoTask>()
const settings: MediaPluginSettings = { seedanceEnabled: false, xaiEnabled: false }
let protocolRegistered = false
const cacheDir = (): string => path.join(app.getPath('userData'), 'media-cache')

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
  registerMessagePackHandler('media:status', async () => ({
    settings,
    ...(await cleanupCache()),
    maxBytes: MEDIA_CACHE_MAX_BYTES
  }))
  registerMessagePackHandler('media:tasks-list', async () => Array.from(tasks.values()))
  registerMessagePackHandler<{ provider: 'seedance' | 'xai'; prompt: string }>(
    'media:task-create',
    async (input) => {
      const enabled = input.provider === 'seedance' ? settings.seedanceEnabled : settings.xaiEnabled
      if (!enabled) throw new Error('Optional video provider plugin is disabled')
      const now = Date.now()
      const task: VideoTask = {
        id: randomUUID(),
        provider: input.provider,
        prompt: input.prompt,
        state: 'queued',
        estimatedCostUsd: null,
        progress: 0,
        createdAt: now,
        updatedAt: now
      }
      tasks.set(task.id, task)
      return task
    }
  )
  registerMessagePackHandler<{ id: string }>('media:task-cancel', async ({ id }) => {
    const task = tasks.get(id)
    if (task && task.state !== 'completed')
      tasks.set(id, { ...task, state: 'cancelled', updatedAt: Date.now() })
    return { success: Boolean(task) }
  })
  registerMessagePackHandler<{ id: string }>('media:task-delete', async ({ id }) => ({
    success: tasks.delete(id)
  }))
  registerMessagePackHandler('media:cache-cleanup', cleanupCache)
}
