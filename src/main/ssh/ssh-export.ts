import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { SshConfigConnection, SshConfigGroup } from './ssh-config'

export interface SshExportPayload {
  schemaVersion: 1
  source: 'ola-ssh'
  exportedAt: number
  groups: SshConfigGroup[]
  connections: SshConfigConnection[]
}

export function buildSshExportPayload(
  config: { groups: SshConfigGroup[]; connections: SshConfigConnection[] },
  connectionIds?: string[],
  exportedAt = Date.now()
): SshExportPayload {
  const selectedIds = connectionIds?.length ? new Set(connectionIds) : null
  const connections = config.connections.filter(
    (connection) => !selectedIds || selectedIds.has(connection.id)
  )
  const groupIds = new Set(connections.map((connection) => connection.groupId))
  return {
    schemaVersion: 1,
    source: 'ola-ssh',
    exportedAt,
    groups: config.groups.filter((group) => groupIds.has(group.id)),
    connections
  }
}

export async function writeSshExportFile(
  filePath: string,
  config: { groups: SshConfigGroup[]; connections: SshConfigConnection[] },
  connectionIds?: string[]
): Promise<void> {
  if (!filePath?.trim()) throw new Error('SSH_EXPORT_PATH_REQUIRED')
  const target = resolve(filePath)
  await mkdir(dirname(target), { recursive: true })
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error('SSH_EXPORT_UNSAFE_FILE')
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(
      temporary,
      JSON.stringify(buildSshExportPayload(config, connectionIds), null, 2),
      {
        mode: 0o600,
        flag: 'wx'
      }
    )
    await chmod(temporary, 0o600)
    // The destination may change while a picker is open; never follow a late symlink.
    const latest = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (latest && (!latest.isFile() || latest.isSymbolicLink()))
      throw new Error('SSH_EXPORT_UNSAFE_FILE')
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}
