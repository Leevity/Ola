import { app, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  createEmptyDrawGraphProject,
  isValidDrawGraphProject,
  type DrawGraphProject
} from '../../shared/draw-graph'
import { registerMessagePackHandler as registerRawMessagePackHandler } from './messagepack-handler'

const MAX_PROJECT_BYTES = 10 * 1024 * 1024
const saveQueues = new Map<string, Promise<void>>()

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
}
