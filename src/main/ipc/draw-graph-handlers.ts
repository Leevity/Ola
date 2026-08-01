import { app, BrowserWindow, protocol, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  createEmptyDrawGraphProject,
  isValidDrawGraphProject,
  type DrawGraphProject
} from '../../shared/draw-graph'
import {
  decodeDrawAssetDataUrl,
  MAX_DRAW_ASSET_BYTES,
  parseJpegSize,
  parsePngSize
} from '../draw/draw-asset-codec'
import { registerMessagePackHandler as registerRawMessagePackHandler } from './messagepack-handler'

const MAX_PROJECT_BYTES = 10 * 1024 * 1024
const saveQueues = new Map<string, Promise<void>>()
let assetProtocolRegistered = false

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
      throw new Error('Unauthorized draw graph IPC sender')
    }
    return await handler(args, event)
  })
}

function safeProjectId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid draw project ID')
  return id
}

function projectPaths(id: string): { target: string; backup: string; temporary: string } {
  const directory = path.join(app.getPath('userData'), 'draw-projects')
  const target = path.join(directory, `${id}.json`)
  return { target, backup: `${target}.bak`, temporary: `${target}.${process.pid}.tmp` }
}

function assetsDirectory(): string {
  return path.join(app.getPath('userData'), 'draw-assets')
}

async function saveAsset(dataUrl: string): Promise<{
  id: string
  mediaType: 'image/png' | 'image/jpeg'
  width: number
  height: number
  url: string
}> {
  const decoded = decodeDrawAssetDataUrl(dataUrl)
  const id = `${crypto.randomUUID()}${decoded.extension}`
  const directory = assetsDirectory()
  await fs.mkdir(directory, { recursive: true })
  const target = path.join(directory, id)
  const temporary = `${target}.tmp`
  await fs.writeFile(temporary, decoded.bytes, { mode: 0o600, flag: 'wx' })
  await fs.rename(temporary, target)
  return {
    id,
    mediaType: decoded.mediaType,
    width: decoded.width,
    height: decoded.height,
    url: `ola-draw-asset://${id}`
  }
}

function registerAssetProtocol(): void {
  if (assetProtocolRegistered) return
  assetProtocolRegistered = true
  protocol.handle('ola-draw-asset', async (request) => {
    const id = new URL(request.url).hostname.toLowerCase()
    if (!/^[a-f0-9-]{36}\.(png|jpg)$/.test(id)) return new Response('Not found', { status: 404 })
    const root = path.resolve(assetsDirectory())
    const filePath = path.resolve(root, id)
    if (!filePath.startsWith(`${root}${path.sep}`))
      return new Response('Forbidden', { status: 403 })
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile() || stat.size > MAX_DRAW_ASSET_BYTES)
        return new Response('Not found', { status: 404 })
      return new Response(await fs.readFile(filePath), {
        headers: {
          'content-type': id.endsWith('.png') ? 'image/png' : 'image/jpeg',
          'cache-control': 'private, max-age=31536000, immutable',
          'access-control-allow-origin': '*'
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function isProject(value: unknown): value is DrawGraphProject {
  return isValidDrawGraphProject(value)
}

async function readProjectFile(filePath: string): Promise<DrawGraphProject | null> {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size > MAX_PROJECT_BYTES) return null
    const value: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'))
    return isProject(value) ? value : null
  } catch {
    return null
  }
}

async function loadProject(id: string): Promise<{ project: DrawGraphProject; recovered: boolean }> {
  const files = projectPaths(id)
  const current = await readProjectFile(files.target)
  if (current) return { project: current, recovered: false }
  const backup = await readProjectFile(files.backup)
  if (backup) {
    await fs.copyFile(files.backup, files.target)
    return { project: backup, recovered: true }
  }
  return { project: createEmptyDrawGraphProject(id), recovered: false }
}

async function saveProject(project: DrawGraphProject): Promise<{ success: true }> {
  if (!isProject(project)) throw new Error('Invalid draw graph project')
  const id = safeProjectId(project.id)
  const files = projectPaths(id)
  const serialized = JSON.stringify({ ...project, id, updatedAt: Date.now() })
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PROJECT_BYTES) {
    throw new Error('Draw graph project exceeds the size limit')
  }
  const previous = saveQueues.get(id) ?? Promise.resolve()
  const save = previous
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(path.dirname(files.target), { recursive: true })
      const temporary = `${files.target}.${process.pid}.${crypto.randomUUID()}.tmp`
      await fs.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 })
      try {
        try {
          await fs.copyFile(files.target, files.backup)
        } catch {
          // The first save has no previous version to back up.
        }
        await fs.rename(temporary, files.target)
      } finally {
        await fs.rm(temporary, { force: true })
      }
    })
  saveQueues.set(id, save)
  await save
  if (saveQueues.get(id) === save) saveQueues.delete(id)
  return { success: true }
}

export function registerDrawGraphHandlers(): void {
  registerAssetProtocol()
  registerMessagePackHandler('draw-graph:list', async () => {
    const directory = path.join(app.getPath('userData'), 'draw-projects')
    try {
      const files = await fs.readdir(directory)
      const projects = await Promise.all(
        files
          .filter((file) => file.endsWith('.json'))
          .map((file) => readProjectFile(path.join(directory, file)))
      )
      return projects
        .filter(isProject)
        .map((project) => ({ id: project.id, name: project.name, updatedAt: project.updatedAt }))
    } catch {
      return []
    }
  })
  registerMessagePackHandler<{ id?: string }>('draw-graph:load', async ({ id }) =>
    loadProject(safeProjectId(id ?? 'default'))
  )
  registerMessagePackHandler<DrawGraphProject>('draw-graph:save', saveProject)
  registerMessagePackHandler<{ dataUrl: string }>('draw-graph:asset-save', async ({ dataUrl }) => {
    if (typeof dataUrl !== 'string') throw new Error('Draw asset data is required')
    return saveAsset(dataUrl)
  })
  registerMessagePackHandler('draw-graph:assets-list', async () => {
    try {
      const files = await fs.readdir(assetsDirectory(), { withFileTypes: true })
      const assets: Array<{
        id: string
        mediaType: string
        width: number
        height: number
        url: string
      }> = []
      for (const entry of files
        .filter((item) => item.isFile() && /^[a-f0-9-]{36}\.(png|jpg)$/.test(item.name))
        .slice(0, 2_000)) {
        const file = await fs.open(path.join(assetsDirectory(), entry.name), 'r')
        try {
          const stat = await file.stat()
          if (stat.size <= 0 || stat.size > MAX_DRAW_ASSET_BYTES) continue
          const bytes = Buffer.alloc(Math.min(stat.size, 2 * 1024 * 1024))
          await file.read(bytes, 0, bytes.length, 0)
          const mediaType = entry.name.endsWith('.png') ? 'image/png' : 'image/jpeg'
          const size = mediaType === 'image/png' ? parsePngSize(bytes) : parseJpegSize(bytes)
          if (!size) continue
          assets.push({
            id: entry.name,
            mediaType,
            ...size,
            url: `ola-draw-asset://${entry.name}`
          })
        } finally {
          await file.close()
        }
      }
      return assets
    } catch {
      return []
    }
  })
}
