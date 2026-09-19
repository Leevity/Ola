import { createHash } from 'crypto'
import { join } from 'path'

/** The legacy personal directory remains stable; managed spaces never share its files. */
export function workspaceMemoryHome(userHome: string, workspaceId: string): string {
  return workspaceMemoryDataRoot(join(userHome, '.ola'), workspaceId)
}

export function workspaceMemoryDataRoot(personalHome: string, workspaceId: string): string {
  if (!workspaceId || workspaceId.length > 1024) throw new Error('Invalid memory workspace')
  if (workspaceId === 'local-personal') return personalHome
  const key = createHash('sha256').update(workspaceId, 'utf8').digest('hex')
  return join(personalHome, 'workspaces', key)
}
