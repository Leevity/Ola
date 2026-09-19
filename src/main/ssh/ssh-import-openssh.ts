import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { olaExternalDataHome } from '../lib/ola-data-root'
import type { SshConfigData } from './ssh-config'
import type { SshImportPreviewConnection, SshImportPreviewResult } from './ssh-transfer'

type HostEntry = { alias: string; options: Map<string, string> }

function trimQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  )
    return trimmed.slice(1, -1)
  return trimmed
}

function expandHome(value: string, home: string): string {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2))
  return value
}

export function parseKnownHosts(text: string): Set<string> {
  const hosts = new Set<string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const field = line.split(/\s+/)[0]
    if (field.startsWith('|1|')) continue
    for (const host of field.split(',')) if (host.trim()) hosts.add(host.trim())
  }
  return hosts
}

export async function loadOpenSshKnownHosts(configPath: string): Promise<Set<string>> {
  const hosts = new Set<string>()
  for (const filePath of [
    join(dirname(resolve(configPath)), 'known_hosts'),
    join(olaExternalDataHome(), '.ssh', 'known_hosts')
  ]) {
    let text: string
    try {
      text = await readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const host of parseKnownHosts(text)) hosts.add(host)
  }
  return hosts
}

export function previewOpenSshImport(
  text: string,
  current: SshConfigData,
  filePath: string,
  knownHosts: ReadonlySet<string> = new Set(),
  home = olaExternalDataHome()
): SshImportPreviewResult {
  const warnings: string[] = []
  const defaults = new Map<string, string>()
  const entries: HostEntry[] = []
  let patterns: string[] | null = null
  let options = new Map<string, string>()

  const flush = (): void => {
    if (!patterns?.length) return
    if (patterns.length === 1 && patterns[0] === '*') {
      for (const [key, value] of options) defaults.set(key, value)
    } else {
      const ignored = patterns.filter(
        (pattern) => pattern.startsWith('!') || pattern.includes('*') || pattern.includes('?')
      )
      if (ignored.length) warnings.push(`Ignored wildcard Host pattern: ${ignored.join(', ')}`)
      for (const alias of patterns) {
        if (ignored.includes(alias)) continue
        entries.push({ alias, options: new Map([...defaults, ...options]) })
      }
    }
    patterns = null
    options = new Map()
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const include = /^Include\s+(.+)$/i.exec(line)
    if (include) {
      warnings.push(`OpenSSH Include not yet supported: ${include[1]}`)
      continue
    }
    const host = /^Host\s+(.+)$/i.exec(line)
    if (host) {
      flush()
      patterns = host[1].split(/\s+/).filter(Boolean)
      continue
    }
    const option = /^\s*([A-Za-z][A-Za-z0-9]*)\s+(.*?)\s*$/.exec(rawLine)
    if (!option) continue
    if (patterns) options.set(option[1].toLowerCase(), option[2])
    else defaults.set(option[1].toLowerCase(), option[2])
  }
  flush()

  const connections: SshImportPreviewConnection[] = []
  for (const [index, entry] of entries.entries()) {
    const host = entry.options.get('hostname') ?? entry.alias
    const username = entry.options.get('user')
    if (!username?.trim()) {
      warnings.push(`Host ${entry.alias} missing User, skipped.`)
      continue
    }
    const rawPort = entry.options.get('port') ?? '22'
    const port =
      /^[+-]?\d+$/.test(rawPort.trim()) &&
      Number(rawPort) >= -2147483648 &&
      Number(rawPort) <= 2147483647
        ? Number(rawPort)
        : 22
    const identity = entry.options.get('identityfile')
    const privateKeyPath = identity?.trim() ? expandHome(trimQuotes(identity), home) : null
    const rowWarnings = privateKeyPath
      ? []
      : ['IdentityFile not found, will default to SSH Agent authentication.']
    const conflict = current.connections.find(
      (connection) =>
        connection.host === host && connection.port === port && connection.username === username
    )
    connections.push({
      importId: `${index}:${entry.alias}:${host}:${port}:${username}`,
      source: 'openssh',
      name: entry.alias,
      host,
      port,
      username,
      authType: privateKeyPath ? 'privateKey' : 'agent',
      groupName: null,
      privateKeyPath,
      proxyJump: entry.options.get('proxyjump') ?? null,
      startupCommand: null,
      defaultDirectory: null,
      keepAliveInterval: null,
      password: null,
      passphrase: null,
      hasKnownHost: knownHosts.has(host) || knownHosts.has(`[${host}]:${port}`),
      needsPrivateKeyReview: !!privateKeyPath,
      warnings: rowWarnings,
      conflictConnectionId: conflict?.id ?? null,
      conflictConnectionName: conflict?.name ?? null,
      defaultAction: conflict ? 'skip' : 'create'
    })
  }
  return {
    source: 'openssh',
    filePath,
    connectionCount: connections.length,
    groups: [],
    warnings,
    connections
  }
}
