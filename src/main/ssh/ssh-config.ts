import * as path from 'path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getNativeWorker } from '../lib/native-worker'
import { olaDataRoot, olaExternalDataHome } from '../lib/ola-data-root'
import { sshWorkspaceConfigPath } from './ssh-workspace-path'
import {
  mutateSshConfigFile,
  normalizeSshConfigDocument,
  patchSshConnection,
  patchSshGroup,
  readSshConfigDocument
} from './ssh-config-json'

export interface OpenSshHostConfig {
  host: string
  hostName?: string
  user?: string
  port?: number
  identityFile?: string
  proxyJump?: string
}

export interface SshConfigGroup {
  id: string
  name: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface SshConfigConnection {
  id: string
  groupId: string | null
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey' | 'agent'
  password: string | null
  privateKeyPath: string | null
  passphrase: string | null
  startupCommand: string | null
  defaultDirectory: string | null
  proxyJump: string | null
  keepAliveInterval: number
  sortOrder: number
  lastConnectedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface SshConfigData {
  groups: SshConfigGroup[]
  connections: SshConfigConnection[]
}

type SshConfigListener = (data: SshConfigData) => void

const EMPTY_CONFIG: SshConfigData = { groups: [], connections: [] }
const SSH_CONFIG_POLL_MS = 30_000

const workspaceContext = new AsyncLocalStorage<string>()
const cachedConfigs = new Map<string, SshConfigData>()
const lastSerialized = new Map<string, string>()
const cacheGenerations = new Map<string, number>()
let watcherStarted = false
let reloadTimer: NodeJS.Timeout | null = null
const initializePromises = new Map<string, Promise<void>>()
const listeners = new Set<SshConfigListener>()

export function currentSshWorkspaceId(): string {
  return workspaceContext.getStore() ?? 'local-personal'
}

export function currentSshWorkspaceGeneration(): number {
  return cacheGenerations.get(currentSshWorkspaceId()) ?? 0
}

export function withSshWorkspace<T>(workspaceId: string, operation: () => T): T {
  if (!workspaceId || workspaceId !== workspaceId.trim() || workspaceId.length > 1024)
    throw new Error('INVALID_SSH_WORKSPACE')
  return workspaceContext.run(workspaceId, operation)
}

function cloneConfig(config: SshConfigData): SshConfigData {
  return {
    groups: config.groups.map((group) => ({ ...group })),
    connections: config.connections.map((connection) => ({ ...connection }))
  }
}

function setCache(workspaceId: string, next: SshConfigData, notify: boolean): void {
  const normalized = normalizeSshConfigDocument(next)
  const serialized = JSON.stringify(normalized)
  cachedConfigs.set(workspaceId, normalized)
  if (serialized === lastSerialized.get(workspaceId)) return
  lastSerialized.set(workspaceId, serialized)
  if (notify) {
    listeners.forEach((listener) => listener(cloneConfig(normalized)))
  }
}

async function nativeRequest<T>(
  method: string,
  params: unknown = {},
  timeoutMs = 60_000
): Promise<T> {
  return await getNativeWorker().request<T>(method, params, timeoutMs)
}

async function refreshFromDisk(notify: boolean): Promise<void> {
  const workspaceId = currentSshWorkspaceId()
  const generation = cacheGenerations.get(workspaceId) ?? 0
  const next = normalizeSshConfigDocument(
    await readSshConfigDocument(getSshConfigPath(workspaceId))
  )
  if ((cacheGenerations.get(workspaceId) ?? 0) === generation) setCache(workspaceId, next, notify)
}

async function mutateConfig(mutation: (current: SshConfigData) => SshConfigData): Promise<void> {
  const workspaceId = currentSshWorkspaceId()
  const generation = cacheGenerations.get(workspaceId) ?? 0
  const canCommit = (): boolean => (cacheGenerations.get(workspaceId) ?? 0) === generation
  const next = await mutateSshConfigFile(getSshConfigPath(workspaceId), mutation, canCommit)
  if ((cacheGenerations.get(workspaceId) ?? 0) === generation) setCache(workspaceId, next, true)
}

/** Drop managed credentials when account or membership authorization changes. */
export function forgetUnavailableSshConfigCaches(availableIds: ReadonlySet<string>): void {
  const managedIds = new Set([
    ...cachedConfigs.keys(),
    ...lastSerialized.keys(),
    ...initializePromises.keys()
  ])
  for (const workspaceId of managedIds) {
    if (workspaceId === 'local-personal' || availableIds.has(workspaceId)) continue
    cacheGenerations.set(workspaceId, (cacheGenerations.get(workspaceId) ?? 0) + 1)
    cachedConfigs.delete(workspaceId)
    lastSerialized.delete(workspaceId)
    initializePromises.delete(workspaceId)
  }
}

export async function reloadSshConfigCache(): Promise<void> {
  await refreshFromDisk(true)
}

export async function initializeSshConfigCache(): Promise<void> {
  const workspaceId = currentSshWorkspaceId()
  if (cachedConfigs.has(workspaceId)) return
  if (!initializePromises.has(workspaceId)) {
    const initializing = refreshFromDisk(false).finally(() => {
      if (initializePromises.get(workspaceId) === initializing)
        initializePromises.delete(workspaceId)
    })
    initializePromises.set(workspaceId, initializing)
  }
  await initializePromises.get(workspaceId)
}

export function startSshConfigWatcher(): void {
  if (watcherStarted) return
  watcherStarted = true
  void initializeSshConfigCache().catch((error) => {
    console.warn('[SSH Config] Initial load failed:', error)
  })
  reloadTimer = setInterval(() => {
    for (const workspaceId of cachedConfigs.keys()) {
      void withSshWorkspace(workspaceId, () => refreshFromDisk(true)).catch((error) => {
        console.warn('[SSH Config] Refresh failed:', error)
      })
    }
  }, SSH_CONFIG_POLL_MS)
  reloadTimer.unref?.()
}

export function stopSshConfigWatcher(): void {
  if (reloadTimer) {
    clearInterval(reloadTimer)
    reloadTimer = null
  }
  watcherStarted = false
}

export function onSshConfigChange(listener: SshConfigListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSshConfigPath(workspaceId = currentSshWorkspaceId()): string {
  return sshWorkspaceConfigPath(olaExternalDataHome(), workspaceId, olaDataRoot())
}

export async function getOpenSshHostConfig(
  alias: string,
  configPath = path.join(olaExternalDataHome(), '.ssh', 'config')
): Promise<OpenSshHostConfig | null> {
  const normalizedAlias = alias.trim()
  if (!normalizedAlias) return null
  return await nativeRequest<OpenSshHostConfig | null>('ssh/config-openssh-host', {
    alias: normalizedAlias,
    configPath
  })
}

export function getSshConfigSnapshot(): SshConfigData {
  return cloneConfig(cachedConfigs.get(currentSshWorkspaceId()) ?? EMPTY_CONFIG)
}

export async function setSshConfigSnapshot(data: SshConfigData): Promise<void> {
  await mutateConfig(() => normalizeSshConfigDocument(data))
}

export function listSshGroups(): SshConfigGroup[] {
  return getSshConfigSnapshot().groups.sort((a, b) => a.sortOrder - b.sortOrder)
}

export function listSshConnections(): SshConfigConnection[] {
  return getSshConfigSnapshot().connections.sort((a, b) => a.sortOrder - b.sortOrder)
}

export function getSshConnection(id: string): SshConfigConnection | undefined {
  return getSshConfigSnapshot().connections.find((connection) => connection.id === id)
}

export async function createSshGroup(group: SshConfigGroup): Promise<void> {
  if (!group.id?.trim() || !group.name?.trim()) throw new Error('Invalid SSH group')
  await mutateConfig((current) => ({
    ...current,
    groups: [...current.groups.filter((item) => item.id !== group.id), group]
  }))
}

export async function updateSshGroup(
  id: string,
  patch: Partial<Pick<SshConfigGroup, 'name' | 'sortOrder' | 'updatedAt'>>
): Promise<void> {
  await mutateConfig((current) => {
    const index = current.groups.findIndex((item) => item.id === id)
    if (index < 0) throw new Error('SSH group not found')
    current.groups[index] = patchSshGroup(current.groups[index], patch)
    return current
  })
}

export async function deleteSshGroup(id: string): Promise<void> {
  await mutateConfig((current) => ({
    groups: current.groups.filter((group) => group.id !== id),
    connections: current.connections.map((connection) =>
      connection.groupId === id ? { ...connection, groupId: null } : connection
    )
  }))
}

export async function createSshConnection(connection: SshConfigConnection): Promise<void> {
  if (
    !connection.id?.trim() ||
    !connection.name?.trim() ||
    !connection.host?.trim() ||
    !connection.username?.trim()
  )
    throw new Error('Invalid SSH connection')
  await mutateConfig((current) => ({
    ...current,
    connections: [...current.connections.filter((item) => item.id !== connection.id), connection]
  }))
}

export async function updateSshConnection(
  id: string,
  patch: Partial<Omit<SshConfigConnection, 'id'>>
): Promise<void> {
  await mutateConfig((current) => {
    const index = current.connections.findIndex((item) => item.id === id)
    if (index < 0) throw new Error('SSH connection not found')
    current.connections[index] = patchSshConnection(current.connections[index], patch)
    return current
  })
}

export async function deleteSshConnection(id: string): Promise<void> {
  await mutateConfig((current) => ({
    ...current,
    connections: current.connections.filter((connection) => connection.id !== id)
  }))
}
