import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import type {
  RemoteConnection,
  RemoteConnectionCreateInput,
  RemoteConnectionListResult,
  RemoteConnectionUpdateInput,
  RdpConnectionConfig,
  VncConnectionConfig
} from '../../shared/remote-control'

type RemoteConnectionConfigFile = {
  version: 1
  connections: RemoteConnection[]
}

const DEFAULT_CONFIG: RemoteConnectionConfigFile = { version: 1, connections: [] }
const CONNECTION_INPUT_KEYS = new Set([
  'kind',
  'groupId',
  'name',
  'host',
  'port',
  'username',
  'credentialRef',
  'tags',
  'rdp',
  'vnc',
  'olaDevice',
  'sortOrder',
  'lastConnectedAt'
])
let mutationQueue: Promise<void> = Promise.resolve()

function runMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation)
  mutationQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

function getConfigPath(): string {
  if (process.env.OLA_REMOTE_CONNECTIONS_PATH) return process.env.OLA_REMOTE_CONNECTIONS_PATH
  return join(homedir(), '.ola', 'remote-connections.json')
}

function now(): number {
  return Date.now()
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeNumber(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function validateConnectionInput(input: RemoteConnectionCreateInput): void {
  if (!input || typeof input !== 'object') throw new Error('Invalid remote connection input')
  const unknownKey = Object.keys(input).find((key) => !CONNECTION_INPUT_KEYS.has(key))
  if (unknownKey) throw new Error(`Unknown remote connection field: ${unknownKey}`)
  if (!['ssh', 'rdp', 'vnc', 'ola-device'].includes(input.kind)) {
    throw new Error('Unsupported remote connection kind')
  }
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) {
    throw new Error('Connection name must be between 1 and 120 characters')
  }
  if (input.host != null && (typeof input.host !== 'string' || input.host.length > 255)) {
    throw new Error('Host is invalid')
  }
  if (
    input.port != null &&
    (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
  ) {
    throw new Error('Port must be an integer between 1 and 65535')
  }
  if (
    input.username != null &&
    (typeof input.username !== 'string' || input.username.length > 255)
  ) {
    throw new Error('Username is invalid')
  }
  if (
    input.credentialRef != null &&
    (typeof input.credentialRef !== 'string' || input.credentialRef.length > 128)
  ) {
    throw new Error('Credential reference is invalid')
  }
  if (
    input.tags != null &&
    (!Array.isArray(input.tags) ||
      input.tags.length > 50 ||
      input.tags.some((tag) => typeof tag !== 'string' || tag.length > 64))
  ) {
    throw new Error('Tags are invalid')
  }
  if (input.rdp != null) {
    if (input.kind !== 'rdp') throw new Error('RDP settings require an RDP connection')
    if (typeof input.rdp !== 'object' || Array.isArray(input.rdp)) {
      throw new Error('RDP settings are invalid')
    }
    const allowedRdp = new Set([
      'colorDepth',
      'audio',
      'clipboard',
      'resize',
      'domain',
      'width',
      'height',
      'launchMode'
    ])
    const unknownRdp = Object.keys(input.rdp).find((key) => !allowedRdp.has(key))
    if (unknownRdp) throw new Error(`Unknown RDP setting: ${unknownRdp}`)
    if (input.rdp.colorDepth != null && ![16, 24, 32].includes(input.rdp.colorDepth)) {
      throw new Error('RDP color depth is invalid')
    }
    if (input.rdp.resize != null && !['fixed', 'stretch', 'dynamic'].includes(input.rdp.resize)) {
      throw new Error('RDP resize mode is invalid')
    }
    if (input.rdp.launchMode != null && !['external', 'embedded'].includes(input.rdp.launchMode)) {
      throw new Error('RDP launch mode is invalid')
    }
    if (
      input.rdp.domain != null &&
      (typeof input.rdp.domain !== 'string' || input.rdp.domain.length > 255)
    ) {
      throw new Error('RDP domain is invalid')
    }
    for (const flag of [input.rdp.audio, input.rdp.clipboard]) {
      if (flag != null && typeof flag !== 'boolean')
        throw new Error('RDP boolean setting is invalid')
    }
    for (const dimension of [input.rdp.width, input.rdp.height]) {
      if (
        dimension != null &&
        (!Number.isInteger(dimension) || dimension < 200 || dimension > 16384)
      ) {
        throw new Error('RDP dimensions are invalid')
      }
    }
  }
  if (input.vnc != null) {
    if (input.kind !== 'vnc') throw new Error('VNC settings require a VNC connection')
    if (typeof input.vnc !== 'object' || Array.isArray(input.vnc)) {
      throw new Error('VNC settings are invalid')
    }
    const allowedVnc = new Set([
      'display',
      'viewOnly',
      'encoding',
      'quality',
      'shared',
      'launchMode'
    ])
    const unknownVnc = Object.keys(input.vnc).find((key) => !allowedVnc.has(key))
    if (unknownVnc) throw new Error(`Unknown VNC setting: ${unknownVnc}`)
    if (input.vnc.encoding != null && !['tight', 'zrle', 'raw'].includes(input.vnc.encoding)) {
      throw new Error('VNC encoding is invalid')
    }
    if (
      input.vnc.quality != null &&
      (!Number.isInteger(input.vnc.quality) || input.vnc.quality < 0 || input.vnc.quality > 9)
    ) {
      throw new Error('VNC quality is invalid')
    }
    if (
      input.vnc.display != null &&
      (!Number.isInteger(input.vnc.display) || input.vnc.display < 0 || input.vnc.display > 99)
    ) {
      throw new Error('VNC display is invalid')
    }
    if (input.vnc.launchMode != null && !['novnc', 'external'].includes(input.vnc.launchMode)) {
      throw new Error('VNC launch mode is invalid')
    }
    for (const flag of [input.vnc.viewOnly, input.vnc.shared]) {
      if (flag != null && typeof flag !== 'boolean')
        throw new Error('VNC boolean setting is invalid')
    }
  }
}

function defaultRdpConfig(input?: Partial<RdpConnectionConfig> | null): RdpConnectionConfig {
  return {
    colorDepth: input?.colorDepth === 16 || input?.colorDepth === 24 ? input.colorDepth : 32,
    audio: input?.audio ?? true,
    clipboard: input?.clipboard ?? true,
    resize: input?.resize ?? 'dynamic',
    domain: normalizeString(input?.domain),
    width: normalizeNumber(input?.width, null),
    height: normalizeNumber(input?.height, null),
    launchMode: input?.launchMode ?? 'external'
  }
}

function defaultVncConfig(input?: Partial<VncConnectionConfig> | null): VncConnectionConfig {
  return {
    display: normalizeNumber(input?.display, 0),
    viewOnly: input?.viewOnly ?? false,
    encoding: input?.encoding ?? 'tight',
    quality: normalizeNumber(input?.quality, 6),
    shared: input?.shared ?? true,
    launchMode: input?.launchMode ?? 'novnc'
  }
}

function normalizeConnection(raw: unknown): RemoteConnection | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const id = normalizeString(value.id)
  const name = normalizeString(value.name)
  const kind = value.kind
  if (
    !id ||
    !name ||
    (kind !== 'ssh' && kind !== 'rdp' && kind !== 'vnc' && kind !== 'ola-device')
  ) {
    return null
  }
  const createdAt = normalizeNumber(value.createdAt, now()) ?? now()
  return {
    id,
    kind,
    groupId: normalizeString(value.groupId),
    name,
    host: normalizeString(value.host),
    port: normalizeNumber(value.port, kind === 'rdp' ? 3389 : kind === 'vnc' ? 5900 : null),
    username: normalizeString(value.username),
    credentialRef: normalizeString(value.credentialRef),
    tags: Array.isArray(value.tags)
      ? value.tags.filter((tag): tag is string => typeof tag === 'string')
      : [],
    lastConnectedAt: normalizeNumber(value.lastConnectedAt, null),
    sortOrder: normalizeNumber(value.sortOrder, 0) ?? 0,
    createdAt,
    updatedAt: normalizeNumber(value.updatedAt, createdAt) ?? createdAt,
    rdp: kind === 'rdp' ? defaultRdpConfig(value.rdp as Partial<RdpConnectionConfig> | null) : null,
    vnc: kind === 'vnc' ? defaultVncConfig(value.vnc as Partial<VncConnectionConfig> | null) : null,
    olaDevice:
      kind === 'ola-device' && value.olaDevice && typeof value.olaDevice === 'object'
        ? (value.olaDevice as RemoteConnection['olaDevice'])
        : null
  }
}

async function readConfig(): Promise<RemoteConnectionConfigFile> {
  const parse = (content: string): RemoteConnectionConfigFile => {
    const parsed = JSON.parse(content) as Partial<RemoteConnectionConfigFile>
    const connections = Array.isArray(parsed.connections)
      ? parsed.connections
          .map(normalizeConnection)
          .filter((item): item is RemoteConnection => !!item)
      : []
    return { version: 1, connections }
  }
  try {
    return parse(await readFile(getConfigPath(), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG
    try {
      return parse(await readFile(`${getConfigPath()}.bak`, 'utf8'))
    } catch {
      throw error
    }
  }
}

async function writeConfig(config: RemoteConnectionConfigFile): Promise<void> {
  const target = getConfigPath()
  const directory = dirname(target)
  const temporary = join(directory, `.remote-connections.${randomUUID()}.tmp`)
  await mkdir(directory, { recursive: true })
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  try {
    await copyFile(target, `${target}.bak`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export async function listRemoteConnections(): Promise<RemoteConnectionListResult> {
  const config = await readConfig()
  return {
    connections: config.connections.slice().sort((left, right) => left.sortOrder - right.sortOrder)
  }
}

export async function getRemoteConnection(id: string): Promise<RemoteConnection | null> {
  const config = await readConfig()
  return config.connections.find((connection) => connection.id === id) ?? null
}

export async function createRemoteConnection(
  input: RemoteConnectionCreateInput
): Promise<RemoteConnection> {
  return runMutation(async () => {
    validateConnectionInput(input)
    const config = await readConfig()
    const timestamp = now()
    const kind = input.kind
    const connection: RemoteConnection = {
      id: randomUUID(),
      kind,
      groupId: input.groupId ?? null,
      name: input.name.trim(),
      host: normalizeString(input.host),
      port: normalizeNumber(input.port, kind === 'rdp' ? 3389 : kind === 'vnc' ? 5900 : null),
      username: normalizeString(input.username),
      credentialRef: normalizeString(input.credentialRef),
      tags: input.tags ?? [],
      lastConnectedAt: null,
      sortOrder: config.connections.length,
      createdAt: timestamp,
      updatedAt: timestamp,
      rdp: kind === 'rdp' ? defaultRdpConfig(input.rdp) : null,
      vnc: kind === 'vnc' ? defaultVncConfig(input.vnc) : null,
      olaDevice: kind === 'ola-device' ? (input.olaDevice ?? null) : null
    }
    if (!connection.name) throw new Error('Connection name is required')
    if ((kind === 'rdp' || kind === 'vnc') && !connection.host) throw new Error('Host is required')
    config.connections.push(connection)
    await writeConfig(config)
    return connection
  })
}

export async function updateRemoteConnection({
  id,
  patch
}: RemoteConnectionUpdateInput): Promise<RemoteConnection> {
  return runMutation(async () => {
    if (typeof id !== 'string' || !id || !patch || typeof patch !== 'object') {
      throw new Error('Invalid remote connection update')
    }
    const unknownKey = Object.keys(patch).find((key) => !CONNECTION_INPUT_KEYS.has(key))
    if (unknownKey) throw new Error(`Unknown remote connection field: ${unknownKey}`)
    const config = await readConfig()
    const index = config.connections.findIndex((connection) => connection.id === id)
    if (index < 0) throw new Error('Remote connection not found')
    const current = config.connections[index]
    const nextKind = patch.kind ?? current.kind
    validateConnectionInput({
      kind: nextKind,
      name: patch.name ?? current.name,
      host: patch.host === undefined ? current.host : patch.host,
      port: patch.port === undefined ? current.port : patch.port,
      username: patch.username === undefined ? current.username : patch.username,
      tags: patch.tags === undefined ? current.tags : patch.tags,
      rdp: nextKind === 'rdp' ? (patch.rdp === undefined ? current.rdp : patch.rdp) : null,
      vnc: nextKind === 'vnc' ? (patch.vnc === undefined ? current.vnc : patch.vnc) : null,
      olaDevice: patch.olaDevice === undefined ? current.olaDevice : patch.olaDevice
    })
    const next: RemoteConnection = {
      ...current,
      ...patch,
      id: current.id,
      kind: patch.kind ?? current.kind,
      name: patch.name?.trim() || current.name,
      updatedAt: now(),
      rdp:
        (patch.kind ?? current.kind) === 'rdp' ? defaultRdpConfig(patch.rdp ?? current.rdp) : null,
      vnc:
        (patch.kind ?? current.kind) === 'vnc' ? defaultVncConfig(patch.vnc ?? current.vnc) : null
    }
    config.connections[index] = normalizeConnection(next) ?? next
    await writeConfig(config)
    return config.connections[index]
  })
}

export async function markRemoteConnectionConnected(id: string): Promise<void> {
  return runMutation(async () => {
    const config = await readConfig()
    const index = config.connections.findIndex((connection) => connection.id === id)
    if (index < 0) return
    const timestamp = now()
    config.connections[index] = {
      ...config.connections[index],
      lastConnectedAt: timestamp,
      updatedAt: timestamp
    }
    await writeConfig(config)
  })
}

export async function deleteRemoteConnection(id: string): Promise<{ success: true }> {
  return runMutation(async () => {
    const config = await readConfig()
    const nextConnections = config.connections.filter((connection) => connection.id !== id)
    if (nextConnections.length === config.connections.length)
      throw new Error('Remote connection not found')
    await writeConfig({ ...config, connections: nextConnections })
    return { success: true }
  })
}
