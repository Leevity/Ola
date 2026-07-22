import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  DRAW_GRAPH_SCHEMA_VERSION,
  createEmptyDrawGraphProject,
  type DrawGraphProject
} from '../../shared/draw-graph'
import { registerMessagePackHandler } from './messagepack-handler'

function safeProjectId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : 'default'
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : 'default'
}

function projectPaths(id: string): { target: string; backup: string; temporary: string } {
  const directory = path.join(app.getPath('userData'), 'draw-projects')
  const target = path.join(directory, `${id}.json`)
  return { target, backup: `${target}.bak`, temporary: `${target}.${process.pid}.tmp` }
}

function isProject(value: unknown): value is DrawGraphProject {
  if (!value || typeof value !== 'object') return false
  const project = value as Partial<DrawGraphProject>
  return (
    project.version === DRAW_GRAPH_SCHEMA_VERSION &&
    Array.isArray(project.nodes) &&
    Array.isArray(project.edges)
  )
}

async function readProjectFile(filePath: string): Promise<DrawGraphProject | null> {
  try {
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
  await fs.mkdir(path.dirname(files.target), { recursive: true })
  await fs.writeFile(
    files.temporary,
    JSON.stringify({ ...project, id, updatedAt: Date.now() }),
    'utf8'
  )
  try {
    await fs.copyFile(files.target, files.backup)
  } catch {
    // The first save has no previous version to back up.
  }
  await fs.rename(files.temporary, files.target)
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
    loadProject(safeProjectId(id))
  )
  registerMessagePackHandler<DrawGraphProject>('draw-graph:save', saveProject)
}
