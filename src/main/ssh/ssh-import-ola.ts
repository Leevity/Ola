import { randomBytes } from 'node:crypto'
import type { SshConfigData } from './ssh-config'
import { normalizeSshConfigDocument } from './ssh-config-json'
import type {
  SshImportAction,
  SshImportApplyResult,
  SshImportPreviewConnection,
  SshImportPreviewResult
} from './ssh-transfer'

function nextId(prefix: string, now: number): string {
  return `${prefix}-${now}-${randomBytes(3).toString('hex')}`
}

export function previewOlaSshImport(
  raw: unknown,
  current: SshConfigData,
  filePath: string
): SshImportPreviewResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Unsupported Ola SSH import file')
  const root = raw as Record<string, unknown>
  const isExport = root.source === 'ola-ssh'
  const original = root.ssh
  if (!isExport && (!original || typeof original !== 'object' || Array.isArray(original)))
    throw new Error('Unsupported Ola SSH import file')
  const source = isExport ? root : (original as Record<string, unknown>)
  // Imported IDs are not destination IDs. Keep repeated source IDs as separate
  // rows, matching Native preview, instead of deduplicating the entire document.
  const groups = (Array.isArray(source.groups) ? source.groups : []).flatMap(
    (group) => normalizeSshConfigDocument({ groups: [group] }).groups
  )
  const importedConnections = (Array.isArray(source.connections) ? source.connections : []).flatMap(
    (connection) => normalizeSshConfigDocument({ connections: [connection] }).connections
  )
  const warnings = isExport
    ? []
    : ['Detected original Ola config structure, imported as SSH segments.']
  const groupNames = new Map(groups.map((group) => [group.id, group.name]))
  const connections: SshImportPreviewConnection[] = importedConnections.map((connection, index) => {
    const rowWarnings = [...warnings]
    if (connection.privateKeyPath?.trim())
      rowWarnings.push(
        'Private key path is from old machine, please verify it is still valid after import.'
      )
    if (connection.groupId?.trim() && !groupNames.has(connection.groupId))
      rowWarnings.push(
        'Group ID cannot be matched, will rebuild by name or fallback to ungrouped during import.'
      )
    const conflict = current.connections.find(
      (existing) =>
        existing.host === connection.host &&
        existing.port === connection.port &&
        existing.username === connection.username
    )
    return {
      importId: `${index}:${connection.name}:${connection.host}:${connection.port}:${connection.username}`,
      source: 'ola',
      name: connection.name,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      authType: connection.authType,
      groupName: connection.groupId ? (groupNames.get(connection.groupId) ?? null) : null,
      privateKeyPath: connection.privateKeyPath,
      proxyJump: connection.proxyJump,
      startupCommand: connection.startupCommand,
      defaultDirectory: connection.defaultDirectory,
      keepAliveInterval: connection.keepAliveInterval,
      password: connection.password,
      passphrase: connection.passphrase,
      hasKnownHost: false,
      needsPrivateKeyReview: !!connection.privateKeyPath?.trim(),
      warnings: rowWarnings,
      conflictConnectionId: conflict?.id ?? null,
      conflictConnectionName: conflict?.name ?? null,
      defaultAction: conflict ? 'skip' : 'create'
    }
  })
  return {
    source: 'ola',
    filePath,
    connectionCount: connections.length,
    groups: groups.map((group) => group.name),
    warnings,
    connections
  }
}

export function applySshImportPreview(
  current: SshConfigData,
  preview: SshImportPreviewResult,
  decisions: Array<{ importId: string; action: SshImportAction }>,
  now = Date.now()
): { config: SshConfigData; result: SshImportApplyResult } {
  const config: SshConfigData = {
    groups: current.groups.map((group) => ({ ...group })),
    connections: current.connections.map((connection) => ({ ...connection }))
  }
  const choices = new Map(decisions.map((decision) => [decision.importId, decision.action]))
  const result: SshImportApplyResult = {
    imported: 0,
    replaced: 0,
    duplicated: 0,
    skipped: 0,
    warnings: []
  }
  for (const connection of preview.connections) {
    const action = choices.get(connection.importId) ?? connection.defaultAction
    if (!['create', 'skip', 'replace', 'duplicate'].includes(action))
      throw new Error('INVALID_SSH_IMPORT_ACTION')
    if (action === 'skip') {
      result.skipped++
      continue
    }
    let groupId: string | null = null
    if (connection.groupName?.trim()) {
      let group = config.groups.find((item) => item.name === connection.groupName)
      if (!group) {
        group = {
          id: nextId('sshg', now),
          name: connection.groupName,
          sortOrder: config.groups.length
            ? Math.max(...config.groups.map((item) => item.sortOrder)) + 1
            : 1,
          createdAt: now,
          updatedAt: now
        }
        config.groups.push(group)
      }
      groupId = group.id
    }
    const conflict = config.connections.find(
      (item) =>
        item.host === connection.host &&
        item.port === connection.port &&
        item.username === connection.username
    )
    if (action === 'replace' && conflict) {
      if (preview.source === 'openssh') {
        Object.assign(conflict, {
          name: connection.name,
          host: connection.host,
          port: connection.port,
          username: connection.username,
          authType: connection.authType,
          privateKeyPath: connection.privateKeyPath,
          proxyJump: connection.proxyJump,
          updatedAt: now
        })
        result.warnings.push(
          `Preserved ${conflict.name} startup command, default directory, heartbeat and password fields.`
        )
      } else {
        Object.assign(conflict, {
          groupId,
          name: connection.name,
          host: connection.host,
          port: connection.port,
          username: connection.username,
          authType: connection.authType,
          password: connection.password,
          privateKeyPath: connection.privateKeyPath,
          passphrase: connection.passphrase,
          startupCommand: connection.startupCommand,
          defaultDirectory: connection.defaultDirectory,
          proxyJump: connection.proxyJump,
          keepAliveInterval: connection.keepAliveInterval ?? conflict.keepAliveInterval,
          updatedAt: now
        })
      }
      result.replaced++
      continue
    }
    let name = connection.name
    if (action === 'duplicate') {
      name = `${connection.name} (Imported)`
      let index = 2
      while (config.connections.some((item) => item.name === name)) {
        name = `${connection.name} (Imported ${index})`
        index++
      }
    }
    config.connections.push({
      id: nextId('sshc', now),
      groupId,
      name,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      authType: connection.authType,
      password: connection.password,
      privateKeyPath: connection.privateKeyPath,
      passphrase: connection.passphrase,
      startupCommand: connection.startupCommand,
      defaultDirectory: connection.defaultDirectory,
      proxyJump: connection.proxyJump,
      keepAliveInterval: connection.keepAliveInterval ?? 60,
      sortOrder: config.connections.length
        ? Math.max(...config.connections.map((item) => item.sortOrder)) + 1
        : 1,
      lastConnectedAt: null,
      createdAt: now,
      updatedAt: now
    })
    if (action === 'duplicate') result.duplicated++
    else result.imported++
  }
  return { config, result }
}
