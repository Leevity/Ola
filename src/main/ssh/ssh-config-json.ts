import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { SshConfigConnection, SshConfigData, SshConfigGroup } from './ssh-config'

function toInt32(value: unknown, fallback: number): number {
  return Number.isInteger(value) &&
    Number(value) >= -2_147_483_648 &&
    Number(value) <= 2_147_483_647
    ? Number(value)
    : fallback
}

function toTimestamp(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) ? Number(value) : fallback
}

function toString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function toAuthType(value: unknown): SshConfigConnection['authType'] {
  if (value === 'privateKey' || value === 'agent' || value === 'password') return value
  return 'password'
}

function normalizeGroup(raw: unknown): SshConfigGroup | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const id = toString(value.id)
  const name = toString(value.name)
  if (!id || !name) return null
  const createdAt = toTimestamp(value.createdAt, Date.now())
  return {
    id,
    name,
    sortOrder: toInt32(value.sortOrder, 0),
    createdAt,
    updatedAt: toTimestamp(value.updatedAt, createdAt)
  }
}

function normalizeConnection(raw: unknown): SshConfigConnection | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const id = toString(value.id)
  const name = toString(value.name)
  const host = toString(value.host)
  const username = toString(value.username)
  if (!id || !name || !host || !username) return null
  const createdAt = toTimestamp(value.createdAt, Date.now())
  return {
    id,
    groupId: toString(value.groupId),
    name,
    host,
    port: toInt32(value.port, 22),
    username,
    authType: toAuthType(value.authType),
    password: toString(value.password),
    privateKeyPath: toString(value.privateKeyPath),
    passphrase: toString(value.passphrase),
    startupCommand: toString(value.startupCommand),
    defaultDirectory: toString(value.defaultDirectory),
    proxyJump: toString(value.proxyJump),
    keepAliveInterval: toInt32(value.keepAliveInterval, 60),
    sortOrder: toInt32(value.sortOrder, 0),
    lastConnectedAt: Number.isSafeInteger(value.lastConnectedAt)
      ? Number(value.lastConnectedAt)
      : null,
    createdAt,
    updatedAt: toTimestamp(value.updatedAt, createdAt)
  }
}

export function normalizeSshConfigDocument(raw: unknown): SshConfigData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { groups: [], connections: [] }
  const value = raw as Record<string, unknown>
  const groupsRaw = Array.isArray(value.groups) ? value.groups : []
  const connectionsRaw = Array.isArray(value.connections) ? value.connections : []
  const groupIds = new Set<string>()
  const connectionIds = new Set<string>()
  const groups = groupsRaw.map(normalizeGroup).filter((group): group is SshConfigGroup => {
    if (!group || groupIds.has(group.id)) return false
    groupIds.add(group.id)
    return true
  })
  const connections = connectionsRaw
    .map(normalizeConnection)
    .filter((connection): connection is SshConfigConnection => {
      if (!connection || connectionIds.has(connection.id)) return false
      connectionIds.add(connection.id)
      return true
    })
  return { groups, connections }
}

export function patchSshGroup(
  group: SshConfigGroup,
  patch: Partial<Pick<SshConfigGroup, 'name' | 'sortOrder' | 'updatedAt'>>
): SshConfigGroup {
  const next = { ...group }
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !patch.name.trim())
      throw new Error('INVALID_SSH_GROUP_NAME')
    next.name = patch.name
  }
  if (patch.sortOrder !== undefined) {
    if (toInt32(patch.sortOrder, NaN) !== patch.sortOrder)
      throw new Error('INVALID_SSH_GROUP_SORT_ORDER')
    next.sortOrder = patch.sortOrder
  }
  if (patch.updatedAt !== undefined) {
    if (!Number.isSafeInteger(patch.updatedAt)) throw new Error('INVALID_SSH_GROUP_UPDATED_AT')
    next.updatedAt = patch.updatedAt
  }
  return next
}

export function patchSshConnection(
  connection: SshConfigConnection,
  patch: Partial<Omit<SshConfigConnection, 'id'>>
): SshConfigConnection {
  const next = { ...connection }
  for (const field of ['name', 'host', 'username'] as const) {
    const value = patch[field]
    if (value === undefined) continue
    if (typeof value !== 'string' || !value.trim()) throw new Error(`INVALID_SSH_${field}`)
    next[field] = value
  }
  for (const field of [
    'groupId',
    'password',
    'privateKeyPath',
    'passphrase',
    'startupCommand',
    'defaultDirectory',
    'proxyJump'
  ] as const) {
    const value = patch[field]
    if (value === undefined) continue
    if (value !== null && typeof value !== 'string') throw new Error(`INVALID_SSH_${field}`)
    next[field] = value
  }
  if (patch.authType !== undefined) {
    if (!['password', 'privateKey', 'agent'].includes(patch.authType))
      throw new Error('INVALID_SSH_AUTH_TYPE')
    next.authType = patch.authType
  }
  for (const field of ['port', 'keepAliveInterval', 'sortOrder'] as const) {
    const value = patch[field]
    if (value === undefined) continue
    if (toInt32(value, NaN) !== value) throw new Error(`INVALID_SSH_${field}`)
    next[field] = value
  }
  if (patch.lastConnectedAt !== undefined) {
    if (patch.lastConnectedAt !== null && !Number.isSafeInteger(patch.lastConnectedAt))
      throw new Error('INVALID_SSH_LAST_CONNECTED_AT')
    next.lastConnectedAt = patch.lastConnectedAt
  }
  if (patch.updatedAt !== undefined) {
    if (!Number.isSafeInteger(patch.updatedAt)) throw new Error('INVALID_SSH_UPDATED_AT')
    next.updatedAt = patch.updatedAt
  }
  return next
}

/** Read only the SSH node while preserving unrelated legacy configuration. */
export async function readSshConfigDocument(path: string): Promise<unknown> {
  try {
    const file = await lstat(path)
    if (!file.isFile() || file.isSymbolicLink()) return null
    const root: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!root || typeof root !== 'object' || Array.isArray(root)) return null
    return (root as Record<string, unknown>).ssh ?? null
  } catch {
    // Match the legacy snapshot route: missing or corrupt configuration is
    // presented as empty, while Native mutations still refuse corrupt writes.
    return null
  }
}

let mutationTail: Promise<void> = Promise.resolve()

export function withSshConfigMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(operation)
  mutationTail = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

async function readRootForMutation(path: string): Promise<{
  root: Record<string, unknown>
  original: string | null
}> {
  const file = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!file) return { root: {}, original: null }
  if (!file.isFile() || file.isSymbolicLink()) throw new Error('SSH_CONFIG_UNSAFE_FILE')
  const original = await readFile(path, 'utf8')
  let root: unknown
  try {
    root = JSON.parse(original)
  } catch {
    throw new Error('SSH_CONFIG_CORRUPT')
  }
  if (!root || typeof root !== 'object' || Array.isArray(root))
    throw new Error('SSH_CONFIG_CORRUPT')
  return { root: root as Record<string, unknown>, original }
}

export async function mutateSshConfigFile(
  path: string,
  mutation: (current: SshConfigData) => SshConfigData,
  canCommit: () => boolean = () => true
): Promise<SshConfigData> {
  return withSshConfigMutation(async () => {
    if (!canCommit()) throw new Error('SSH_WORKSPACE_REVOKED')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const { root, original } = await readRootForMutation(path)
    const current = normalizeSshConfigDocument(root.ssh)
    const next = normalizeSshConfigDocument(mutation(current))
    const latest = await readRootForMutation(path)
    if (latest.original !== original) throw new Error('SSH_CONFIG_CONCURRENT_MODIFICATION')
    if (!canCommit()) throw new Error('SSH_WORKSPACE_REVOKED')
    root.ssh = next
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(root, null, 2), { mode: 0o600, flag: 'wx' })
      await chmod(temporary, 0o600)
      if (!canCommit()) throw new Error('SSH_WORKSPACE_REVOKED')
      await rename(temporary, path)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
    return next
  })
}
