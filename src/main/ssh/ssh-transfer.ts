import { readFile } from 'node:fs/promises'
import type { SshConfigConnection } from './ssh-config'
import { currentSshWorkspaceGeneration, getSshConfigPath, reloadSshConfigCache } from './ssh-config'
import {
  mutateSshConfigFile,
  normalizeSshConfigDocument,
  readSshConfigDocument
} from './ssh-config-json'
import { writeSshExportFile } from './ssh-export'
import { applySshImportPreview, previewOlaSshImport } from './ssh-import-ola'
import { loadOpenSshKnownHosts, previewOpenSshImport } from './ssh-import-openssh'

export type SshImportSource = 'ola' | 'openssh'
export type SshImportAction = 'create' | 'skip' | 'replace' | 'duplicate'

export type { SshExportPayload } from './ssh-export'

export interface SshImportPreviewConnection {
  importId: string
  source: SshImportSource
  name: string
  host: string
  port: number
  username: string
  authType: SshConfigConnection['authType']
  groupName: string | null
  privateKeyPath: string | null
  proxyJump: string | null
  startupCommand: string | null
  defaultDirectory: string | null
  keepAliveInterval: number | null
  password: string | null
  passphrase: string | null
  hasKnownHost: boolean
  needsPrivateKeyReview: boolean
  warnings: string[]
  conflictConnectionId: string | null
  conflictConnectionName: string | null
  defaultAction: SshImportAction
}

export interface SshImportPreviewResult {
  source: SshImportSource
  filePath: string
  connectionCount: number
  groups: string[]
  warnings: string[]
  connections: SshImportPreviewConnection[]
  error?: string
}

export interface SshImportApplyResult {
  imported: number
  replaced: number
  duplicated: number
  skipped: number
  warnings: string[]
  error?: string
}

export async function exportSshConfig(filePath: string, connectionIds?: string[]): Promise<void> {
  const config = normalizeSshConfigDocument(await readSshConfigDocument(getSshConfigPath()))
  await writeSshExportFile(filePath, config, connectionIds)
}

export async function previewSshImport(
  filePath: string,
  source: SshImportSource
): Promise<SshImportPreviewResult> {
  if (source !== 'ola' && source !== 'openssh') throw new Error('INVALID_SSH_IMPORT_SOURCE')
  const text = await readFile(filePath, 'utf8')
  const current = normalizeSshConfigDocument(await readSshConfigDocument(getSshConfigPath()))
  if (source === 'ola') {
    const raw: unknown = JSON.parse(text)
    return previewOlaSshImport(raw, current, filePath)
  }
  return previewOpenSshImport(text, current, filePath, await loadOpenSshKnownHosts(filePath))
}

export async function applySshImport(
  filePath: string,
  source: SshImportSource,
  decisions: Array<{ importId: string; action: SshImportAction }>
): Promise<SshImportApplyResult> {
  const generation = currentSshWorkspaceGeneration()
  const canCommit = (): boolean => currentSshWorkspaceGeneration() === generation
  if (source !== 'ola' && source !== 'openssh') throw new Error('INVALID_SSH_IMPORT_SOURCE')
  const text = await readFile(filePath, 'utf8')
  const raw: unknown = source === 'ola' ? JSON.parse(text) : null
  const knownHosts =
    source === 'openssh' ? await loadOpenSshKnownHosts(filePath) : new Set<string>()
  let result: SshImportApplyResult | undefined
  await mutateSshConfigFile(
    getSshConfigPath(),
    (current) => {
      const preview =
        source === 'ola'
          ? previewOlaSshImport(raw, current, filePath)
          : previewOpenSshImport(text, current, filePath, knownHosts)
      const applied = applySshImportPreview(current, preview, decisions)
      result = applied.result
      return applied.config
    },
    canCommit
  )
  if (!canCommit()) throw new Error('SSH_WORKSPACE_REVOKED')
  await reloadSshConfigCache()
  if (!result) throw new Error('SSH_IMPORT_APPLY_FAILED')
  return result
}
