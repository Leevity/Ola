import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { workspaceMemoryDataRoot } from './workspace-memory-path'

/** New outputs share the app data root; stored absolute paths continue to resolve old files. */
export function generatedImagesDirectory(olaRoot: string, workspaceId: string): string {
  return join(workspaceMemoryDataRoot(olaRoot, workspaceId), 'generated-images')
}

export function ensureGeneratedImagesDirectory(olaRoot: string, workspaceId: string): string {
  const directory = generatedImagesDirectory(olaRoot, workspaceId)
  mkdirSync(olaRoot, { recursive: true })
  if (workspaceId === 'local-personal') {
    try {
      mkdirSync(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const status = lstatSync(directory)
    if (status.isSymbolicLink() || !status.isDirectory())
      throw new Error('Generated image workspace directory is not a regular directory')
    return directory
  }
  const parts = [
    'workspaces',
    basename(workspaceMemoryDataRoot(olaRoot, workspaceId)),
    'generated-images'
  ]
  let current = olaRoot
  for (const part of parts) {
    current = join(current, part)
    try {
      mkdirSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const status = lstatSync(current)
    if (status.isSymbolicLink() || !status.isDirectory())
      throw new Error('Generated image workspace directory is not a regular directory')
  }
  return directory
}

export function assertGeneratedImageSourcePath(
  workspaceId: string,
  directory: string,
  sourcePath: string
): void {
  if (workspaceId === 'local-personal') return
  const root = realpathSync(directory)
  const source = realpathSync(resolve(sourcePath))
  const inside = relative(root, source)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new Error('Generated image source is outside this workspace')
}

export function validateGeneratedImageRunId(runId: string | undefined): string | undefined {
  if (runId === undefined) return undefined
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(runId)) throw new Error('Invalid generated image run ID')
  return runId
}
