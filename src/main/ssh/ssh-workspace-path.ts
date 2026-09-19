import { join } from 'node:path'
import { workspaceMemoryDataRoot } from '../lib/workspace-memory-path'

export function sshWorkspaceConfigPath(
  userHome: string,
  workspaceId: string,
  dataRoot = join(userHome, '.ola')
): string {
  if (workspaceId === 'local-personal') return join(userHome, '.ola.json')
  return join(workspaceMemoryDataRoot(dataRoot, workspaceId), 'ssh.json')
}
