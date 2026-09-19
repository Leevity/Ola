import { createHash } from 'crypto'

/** Preserve pre-workspace personal Wiki rows; other spaces use an opaque key. */
export function wikiWorkspaceStorageKey(projectRoot: string, workspaceId: string): string {
  if (workspaceId === 'local-personal') return projectRoot
  const digest = createHash('sha256')
    .update(JSON.stringify([workspaceId, projectRoot]))
    .digest('hex')
  return `workspace-wiki:${digest}`
}
