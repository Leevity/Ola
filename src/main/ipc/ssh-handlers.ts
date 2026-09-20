import { app, ipcMain, BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { Client, type ConnectConfig, type ClientChannel, type SFTPWrapper, type Stats } from 'ssh2'
import * as fs from 'fs'
import * as path from 'path'
import { SftpWorkspaceActivity } from '../ssh/sftp-workspace-activity'
import { SshWorkspaceSwitchGate } from '../ssh/ssh-workspace-switch-gate'
import { revokeUnavailableWorkspaceResources } from '../ssh/ssh-workspace-revocation'
import {
  startSshConfigWatcher,
  initializeSshConfigCache,
  withSshWorkspace,
  currentSshWorkspaceId,
  forgetUnavailableSshConfigCaches,
  onSshConfigChange,
  listSshGroups,
  createSshGroup,
  updateSshGroup,
  deleteSshGroup,
  listSshConnections,
  getSshConnection,
  createSshConnection,
  updateSshConnection,
  deleteSshConnection,
  getOpenSshHostConfig,
  type SshConfigGroup,
  type SshConfigConnection,
  type OpenSshHostConfig
} from '../ssh/ssh-config'
import { loadOfflineWorkspaceIds } from '../remote/account-client'
import { onRemoteAccountCleared, onWorkspaceDirectoryChanged } from '../remote/account-lifecycle'
import { authorizeSshWorkspace } from '../ssh/ssh-workspace-authorization'
import { sshSessionsForConnection } from '../ssh/ssh-session-scope'
import {
  applySshImport,
  exportSshConfig,
  previewSshImport,
  type SshImportAction,
  type SshImportSource
} from '../ssh/ssh-transfer'
import {
  buildFileSnapshot,
  buildOpaqueExistingSnapshot,
  recordSshTextWriteChange,
  registerSshChangeAdapter,
  type FileSnapshot
} from './agent-change-handlers'
import { safeSendMessagePackToAllWindows, safeSendMessagePackToWindow } from '../window-ipc'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'

// ── SSH Session Manager ──

interface SshSession {
  id: string
  connectionId: string
  workspaceId: string
  ownerWindowId: number
  client: Client
  shell: ClientChannel | null
  status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error'
  error?: string
  outputSeq: number
  outputBuffer: { seq: number; data: Buffer }[]
  outputBufferSize: number
  jumpClient?: Client
  userInitiatedDisconnect: boolean
  reconnectAttempts: number
  reconnectTimer?: ReturnType<typeof setTimeout>
}

interface ResolvedJumpTarget {
  source: 'alias' | 'connectionId' | 'string'
  label: string
  connection: SshConfigConnection
}

interface LayeredSshError {
  stage: 'jump_connect' | 'jump_auth' | 'target_connect' | 'target_auth' | 'config'
  message: string
  cause?: unknown
}

const sshSessions = new Map<string, SshSession>()
;(globalThis as typeof globalThis & { __olaSshSessions?: typeof sshSessions }).__olaSshSessions =
  sshSessions
let nextSessionId = 1
const MAX_OUTPUT_BUFFER_BYTES = 1024 * 1024
const MAX_SSH_DIAGNOSTIC_ENTRIES = 500
const MAX_SSH_RECONNECT_ATTEMPTS = 3
const sshDiagnostics: Array<{
  id: number
  sessionId: string
  connectionId: string
  workspaceId: string
  ownerWindowId: number
  stage: 'dial' | 'handshake' | 'auth' | 'shell' | 'reconnect'
  level: 'info' | 'error'
  message: string
  timestamp: number
}> = []
let nextSshDiagnosticId = 1
const DEFAULT_TEXT_LINE_READ_LIMIT = 1_000
const TEXT_READ_BLOCKED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.ico',
  '.tiff',
  '.heic',
  '.heif',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.zip',
  '.gz',
  '.tgz',
  '.rar',
  '.7z',
  '.tar'
])
let sshConfigWatcherAttached = false
let accountRevocationSubscribed = false

type SshClientSession = {
  connectionId: string
}

export interface SshExecResult {
  success: boolean
  exitCode: number
  stdout: string
  stderr: string
  error?: string | null
  timing?: {
    totalMs: number
    spawnMs: number
    timedOut: boolean
    engine: string
  }
}

interface ReadTextFileLinesResult {
  content: string
  name: string
  path: string
  lineCount: number
  maxLines: number
  truncated: boolean
}

function clampTextLineReadLimit(maxLines?: number): number {
  if (typeof maxLines !== 'number' || !Number.isFinite(maxLines)) {
    return DEFAULT_TEXT_LINE_READ_LIMIT
  }
  return Math.max(1, Math.min(DEFAULT_TEXT_LINE_READ_LIMIT, Math.floor(maxLines)))
}

type UploadStage = 'upload' | 'cleanup' | 'done' | 'error' | 'canceled'

type UploadProgress = {
  current?: number
  total?: number
  percent?: number
}

type UploadEvent = {
  taskId: string
  connectionId: string
  stage: UploadStage
  progress?: UploadProgress
  message?: string
}

type UploadTaskState = {
  taskId: string
  connectionId: string
  workspaceId: string
  ownerWindowId: number
  canceled: boolean
  started: boolean
  cancel: (reason?: string) => Promise<void>
}

type SshConflictPolicy = 'skip' | 'overwrite' | 'duplicate'

type TransferTaskType = 'upload' | 'download' | 'remote-copy'

type TransferStage = 'preparing' | 'transferring' | 'cleanup' | 'done' | 'error' | 'canceled'

type TransferProgress = {
  currentBytes?: number
  totalBytes?: number
  percent?: number
  processedItems?: number
  totalItems?: number
}

type TransferEvent = {
  taskId: string
  type: TransferTaskType
  stage: TransferStage
  sourceConnectionId?: string | null
  targetConnectionId?: string | null
  progress?: TransferProgress
  message?: string
  currentItem?: string
  conflictPolicy?: SshConflictPolicy
}

type TransferTaskState = {
  taskId: string
  type: TransferTaskType
  workspaceId: string
  ownerWindowId: number
  sourceConnectionId?: string | null
  targetConnectionId?: string | null
  canceled: boolean
  started: boolean
  cancel: (reason?: string) => Promise<void>
}

type SearchLimitReason = 'max_results' | 'max_output_bytes' | 'timeout' | 'max_depth' | null
type GrepMatchKind = 'match' | 'context'
type GrepOutputMode = 'matches' | 'files_with_matches' | 'files_without_matches' | 'count'
type SearchEngine = string

type SearchMeta = {
  backend: 'ssh'
  engine?: SearchEngine
  searchRoot: string
  pathStyle: 'absolute' | 'relative_to_search_root'
  truncated: boolean
  timedOut: boolean
  limitReason: SearchLimitReason
  pattern: string
  include?: string | null
  exclude?: string | null
  outputMode?: GrepOutputMode
  hiddenIncluded: boolean
  ignoredDefaultsApplied: boolean
  respectGitignore?: boolean
  followSymlinks?: boolean
  warnings?: string[]
  maxDepth?: number | null
  beforeContext?: number
  afterContext?: number
  maxResults?: number
}

type SshGlobResult = {
  kind: 'glob'
  matches: Array<{ path: string; type?: 'file' | 'directory' }>
  meta: SearchMeta
  error?: string
}

type SshGrepResult = {
  kind: 'grep'
  matches: Array<{
    path: string
    line?: number
    text?: string
    kind?: GrepMatchKind
    count?: number
  }>
  meta: SearchMeta
  error?: string
}

const uploadTasks = new Map<string, UploadTaskState>()
const transferTasks = new Map<string, TransferTaskState>()
const sftpWorkspaceActivity = new SftpWorkspaceActivity()
const sshWorkspaceSwitchGate = new SshWorkspaceSwitchGate()

export function beginMainSshWorkspaceSwitch(): () => void {
  return sshWorkspaceSwitchGate.beginSwitch(hasActiveMainSshWorkspaceActivity)
}

export function hasActiveMainSshWorkspaceActivity(): boolean {
  return (
    [...sshSessions.values()].some((session) =>
      ['connecting', 'connected', 'reconnecting'].includes(session.status)
    ) ||
    uploadTasks.size > 0 ||
    transferTasks.size > 0 ||
    sftpWorkspaceActivity.hasActivity((windowId) => {
      const window = BrowserWindow.fromId(windowId)
      return window !== null && !window.isDestroyed()
    })
  )
}

/** Disconnect account-owned SSH activity before another account can use the process. */
export async function revokeManagedSshWorkspaceActivity(): Promise<void> {
  await revokeUnavailableSshWorkspaceActivity(new Set())
}

async function revokeUnavailableSshWorkspaceActivity(
  availableIds: ReadonlySet<string>
): Promise<void> {
  forgetUnavailableSshConfigCaches(availableIds)
  const outcomes = await Promise.allSettled([
    revokeUnavailableWorkspaceResources(sshSessions, availableIds, (session, sessionId) => {
      session.userInitiatedDisconnect = true
      session.status = 'disconnected'
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer)
      const closeErrors: unknown[] = []
      for (const transport of [session.shell, session.client, session.jumpClient]) {
        if (!transport) continue
        try {
          transport.destroy()
        } catch (error) {
          closeErrors.push(error)
        }
      }
      sendSshSessionMessage(session, 'ssh:status', {
        sessionId,
        connectionId: session.connectionId,
        status: 'disconnected'
      })
      if (closeErrors.length) throw new AggregateError(closeErrors, 'SSH session close failed')
    }),
    revokeUnavailableWorkspaceResources(uploadTasks, availableIds, (task) =>
      task.cancel('Account changed')
    ),
    revokeUnavailableWorkspaceResources(transferTasks, availableIds, (task) =>
      task.cancel('Account changed')
    )
  ])
  sftpWorkspaceActivity.forgetUnavailableWorkspaces(availableIds)
  const remainingDiagnostics = sshDiagnostics.filter(
    (entry) => entry.workspaceId === 'local-personal' || availableIds.has(entry.workspaceId)
  )
  sshDiagnostics.splice(0, sshDiagnostics.length, ...remainingDiagnostics)
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : []
  )
  if (errors.length) throw new AggregateError(errors, 'SSH workspace revocation incomplete')
}

function logSshDebug(message: string, details: Record<string, unknown>): void {
  if (!isSshDebugEnabled()) return
  console.log(`[SSH] ${message}`, details)
}

function isSshDebugEnabled(): boolean {
  const raw = process.env.OLA_SSH_DEBUG ?? process.env.OLA_NATIVE_DEBUG
  if (raw !== undefined) {
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
  }
  return !app.isPackaged
}

function sendUploadEvent(evt: UploadEvent): void {
  const ownerWindowId = uploadTasks.get(evt.taskId)?.ownerWindowId
  const ownerWindow = ownerWindowId ? BrowserWindow.fromId(ownerWindowId) : null
  if (ownerWindow && !ownerWindow.isDestroyed()) {
    safeSendMessagePackToWindow(ownerWindow, 'ssh:fs:upload:events', evt)
  }
}

function sendTransferEvent(evt: TransferEvent): void {
  const ownerWindowId = transferTasks.get(evt.taskId)?.ownerWindowId
  const ownerWindow = ownerWindowId ? BrowserWindow.fromId(ownerWindowId) : null
  if (ownerWindow && !ownerWindow.isDestroyed()) {
    safeSendMessagePackToWindow(ownerWindow, 'ssh:fs:transfer:events', evt)
  }
}

function isSshTaskOwnedBy(event: IpcMainInvokeEvent, ownerWindowId: number): boolean {
  return BrowserWindow.fromWebContents(event.sender)?.id === ownerWindowId
}

function nowStamp(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  )
}

async function checkRemoteCommandExists(session: SshClientSession, cmd: string): Promise<boolean> {
  const result = await sshExec(session, `command -v ${cmd} >/dev/null 2>&1`)
  return result.exitCode === 0
}

interface SshGroupRow {
  id: string
  name: string
  sort_order: number
  created_at: number
  updated_at: number
}

interface SshConnectionRow {
  id: string
  group_id: string | null
  name: string
  host: string
  port: number
  username: string
  auth_type: string
  private_key_path: string | null
  startup_command: string | null
  default_directory: string | null
  proxy_jump: string | null
  keep_alive_interval: number
  sort_order: number
  last_connected_at: number | null
  created_at: number
  updated_at: number
}

function sendSshSessionMessage(session: SshSession, channel: string, data: unknown): void {
  const ownerWindow = BrowserWindow.fromId(session.ownerWindowId)
  if (ownerWindow && !ownerWindow.isDestroyed()) {
    safeSendMessagePackToWindow(ownerWindow, channel, data)
  }
}

function isSshSessionOwnedBy(
  event: IpcMainInvokeEvent | IpcMainEvent,
  sessionId: string,
  workspaceId = currentSshWorkspaceId()
): boolean {
  const session = sshSessions.get(sessionId)
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  return Boolean(
    session &&
    ownerWindow &&
    session.ownerWindowId === ownerWindow.id &&
    session.workspaceId === workspaceId
  )
}

function ensureSshConfigWatcher(): void {
  if (sshConfigWatcherAttached) return
  sshConfigWatcherAttached = true
  startSshConfigWatcher()
  onSshConfigChange(() => {
    safeSendMessagePackToAllWindows('ssh:config:changed', {})
  })
}

function toGroupRow(group: SshConfigGroup): SshGroupRow {
  return {
    id: group.id,
    name: group.name,
    sort_order: group.sortOrder,
    created_at: group.createdAt,
    updated_at: group.updatedAt
  }
}

function toConnectionRow(connection: SshConfigConnection): SshConnectionRow {
  return {
    id: connection.id,
    group_id: connection.groupId,
    name: connection.name,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    auth_type: connection.authType,
    private_key_path: connection.privateKeyPath,
    startup_command: connection.startupCommand,
    default_directory: connection.defaultDirectory,
    proxy_jump: connection.proxyJump,
    keep_alive_interval: connection.keepAliveInterval,
    sort_order: connection.sortOrder,
    last_connected_at: connection.lastConnectedAt,
    created_at: connection.createdAt,
    updated_at: connection.updatedAt
  }
}

function buildConnectConfig(connection: SshConfigConnection): ConnectConfig {
  if (!connection) throw new Error('Connection not found')

  const config: ConnectConfig = {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    keepaliveInterval: (connection.keepAliveInterval ?? 60) * 1000,
    keepaliveCountMax: 3,
    readyTimeout: 30000
  }

  if (connection.authType === 'password') {
    if (!connection.password) {
      throw new Error('Password is required for password authentication')
    }
    config.password = connection.password
  } else if (connection.authType === 'privateKey') {
    if (!connection.privateKeyPath) {
      throw new Error('Private key path is required for private key authentication')
    }
    try {
      config.privateKey = fs.readFileSync(connection.privateKeyPath, 'utf-8')
    } catch (err) {
      throw new Error(`Failed to read private key: ${err}`)
    }
    if (connection.passphrase) {
      config.passphrase = connection.passphrase
    }
  } else if (connection.authType === 'agent') {
    config.agent =
      process.platform === 'win32'
        ? '\\\\.\\pipe\\openssh-ssh-agent'
        : process.env.SSH_AUTH_SOCK || undefined
  } else {
    throw new Error(`Unsupported authentication type: ${connection.authType}`)
  }

  return config
}

function toLayeredError(
  stage: LayeredSshError['stage'],
  message: string,
  cause?: unknown
): LayeredSshError {
  return { stage, message, cause }
}

function isAuthFailureMessage(message: string): boolean {
  return message.includes('All configured authentication methods failed')
}

function formatLayeredError(
  err: unknown,
  fallbackAuthType?: SshConfigConnection['authType']
): string {
  if (err && typeof err === 'object' && 'stage' in err && 'message' in err) {
    const layered = err as LayeredSshError
    const raw = layered.message || ''
    if (layered.stage === 'jump_auth') {
      return `Jump host authentication failed: ${raw}`
    }
    if (layered.stage === 'jump_connect') {
      return `Jump host connection failed: ${raw}`
    }
    if (layered.stage === 'target_auth') {
      if (fallbackAuthType === 'password')
        return 'Target host password authentication failed, please check your password.'
      if (fallbackAuthType === 'privateKey')
        return 'Target host private key authentication failed, please check key or passphrase.'
      if (fallbackAuthType === 'agent')
        return 'Target host SSH Agent authentication failed, please check Agent status.'
      return `Target host authentication failed: ${raw}`
    }
    if (layered.stage === 'target_connect') {
      return `Target host connection failed: ${raw}`
    }
    return raw
  }

  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('ECONNREFUSED')) return 'Connection refused, please check host and port.'
  if (message.includes('ETIMEDOUT') || message.includes('timeout'))
    return 'Connection timed out, please check network reachability.'
  if (message.includes('ENOTFOUND') || message.includes('getaddrinfo'))
    return 'Host not resolvable, please check hostname or IP.'
  if (isAuthFailureMessage(message)) {
    if (fallbackAuthType === 'password')
      return 'Password authentication failed, please check password.'
    if (fallbackAuthType === 'privateKey')
      return 'Private key authentication failed, please check key file and passphrase.'
    if (fallbackAuthType === 'agent')
      return 'SSH Agent authentication failed, please check Agent availability.'
  }
  return message
}

function createDerivedConnection(
  base: SshConfigConnection,
  patch: Partial<SshConfigConnection>
): SshConfigConnection {
  return {
    ...base,
    ...patch,
    id: patch.id ?? base.id,
    name: patch.name ?? base.name,
    host: patch.host ?? base.host,
    port: patch.port ?? base.port,
    username: patch.username ?? base.username,
    authType: patch.authType ?? base.authType,
    password: patch.password ?? base.password,
    privateKeyPath: patch.privateKeyPath ?? base.privateKeyPath,
    passphrase: patch.passphrase ?? base.passphrase,
    keepAliveInterval: patch.keepAliveInterval ?? base.keepAliveInterval,
    proxyJump: patch.proxyJump ?? base.proxyJump
  }
}

function parseOpenSshJumpString(
  raw: string
): { username?: string; host: string; port?: number } | null {
  const value = raw.trim()
  if (!value) return null
  const match = value.match(/^(?:(?<username>[^@]+)@)?(?<host>[^:]+?)(?::(?<port>\d+))?$/)
  if (!match?.groups?.host) return null
  const port = match.groups.port ? Number.parseInt(match.groups.port, 10) : undefined
  return {
    username: match.groups.username,
    host: match.groups.host,
    port: Number.isFinite(port) ? port : undefined
  }
}

function openSshHostToConnection(
  alias: string,
  hostConfig: OpenSshHostConfig,
  target: SshConfigConnection
): SshConfigConnection {
  return createDerivedConnection(target, {
    id: `alias:${alias}`,
    name: alias,
    host: hostConfig.hostName ?? alias,
    port: hostConfig.port ?? 22,
    username: hostConfig.user ?? target.username,
    authType: hostConfig.identityFile ? 'privateKey' : target.authType,
    privateKeyPath: hostConfig.identityFile ?? target.privateKeyPath,
    password: hostConfig.identityFile ? null : target.password,
    passphrase: hostConfig.identityFile ? target.passphrase : target.passphrase,
    proxyJump: null
  })
}

async function resolveProxyJumpTarget(
  target: SshConfigConnection
): Promise<ResolvedJumpTarget | null> {
  const raw = target.proxyJump?.trim()
  if (!raw) return null

  const aliasConfig = await getOpenSshHostConfig(raw)
  if (aliasConfig) {
    return {
      source: 'alias',
      label: raw,
      connection: openSshHostToConnection(raw, aliasConfig, target)
    }
  }

  const saved = getSshConnection(raw)
  if (saved) {
    return {
      source: 'connectionId',
      label: saved.name || saved.id,
      connection: createDerivedConnection(saved, { proxyJump: null })
    }
  }

  const parsed = parseOpenSshJumpString(raw)
  if (!parsed) return null
  return {
    source: 'string',
    label: raw,
    connection: createDerivedConnection(target, {
      id: `jump:${raw}`,
      name: raw,
      host: parsed.host,
      port: parsed.port ?? 22,
      username: parsed.username ?? target.username,
      proxyJump: null
    })
  }
}

function formatProxyJumpConnection(connection: SshConfigConnection): string {
  const host = connection.host.includes(':') ? `[${connection.host}]` : connection.host
  const prefix = connection.username ? `${connection.username}@` : ''
  return connection.port && connection.port !== 22
    ? `${prefix}${host}:${connection.port}`
    : `${prefix}${host}`
}

function resolveNativeProxyJump(target: SshConfigConnection): string | null {
  const raw = target.proxyJump?.trim()
  if (!raw) return null

  const saved = getSshConnection(raw)
  if (saved) {
    return formatProxyJumpConnection(createDerivedConnection(saved, { proxyJump: null }))
  }

  const parsed = parseOpenSshJumpString(raw)
  if (!parsed || (!raw.includes('@') && !raw.includes(':'))) return raw
  return formatProxyJumpConnection(
    createDerivedConnection(target, {
      id: `jump:${raw}`,
      name: raw,
      host: parsed.host,
      port: parsed.port ?? 22,
      username: parsed.username ?? target.username,
      proxyJump: null
    })
  )
}

function toSshConnectionPayload(connection: SshConfigConnection): Record<string, unknown> {
  const authFields: Record<string, unknown> = {}
  if (connection.authType === 'password') {
    authFields.password = connection.password
  } else if (connection.authType === 'privateKey') {
    authFields.privateKeyPath = connection.privateKeyPath
    authFields.passphrase = connection.passphrase
  }

  return {
    id: connection.id,
    host: connection.host,
    port: connection.port,
    username: connection.username,
    authType: connection.authType,
    proxyJump: resolveNativeProxyJump(connection),
    ...authFields
  }
}

export function getSshConnectionPayload(connectionId: string): Record<string, unknown> | null {
  const connection = getSshConnection(connectionId)
  return connection ? toSshConnectionPayload(connection) : null
}

export async function execSshCommand(
  connectionId: string,
  command: string,
  timeout = 60_000
): Promise<SshExecResult> {
  const connection = getSshConnection(connectionId)
  if (!connection) {
    return {
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: 'Connection not found',
      error: 'Connection not found'
    }
  }

  const startedAt = Date.now()
  let client: Client | undefined
  let jumpClient: Client | undefined
  let timer: NodeJS.Timeout | undefined
  try {
    const connected = await withSshWorkspace(currentSshWorkspaceId(), () =>
      connectWithProxyJump(connection)
    )
    client = connected.client
    jumpClient = connected.jumpClient
    const result = await new Promise<SshExecResult>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (value: SshExecResult): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(value)
      }
      client?.exec(command, (error, stream) => {
        if (error) {
          reject(error)
          return
        }
        stream.setEncoding('utf8')
        stream.on('data', (chunk: string) => {
          stdout += chunk
        })
        stream.stderr?.setEncoding('utf8')
        stream.stderr?.on('data', (chunk: string) => {
          stderr += chunk
        })
        stream.once('close', (code: number | null) => {
          finish({
            success: (code ?? 1) === 0,
            exitCode: code ?? 1,
            stdout,
            stderr,
            timing: {
              totalMs: Date.now() - startedAt,
              spawnMs: Date.now() - startedAt,
              timedOut: false,
              engine: 'ssh2'
            }
          })
        })
        timer = setTimeout(() => {
          stream.destroy()
          finish({
            success: false,
            exitCode: 124,
            stdout,
            stderr: `${stderr}${stderr ? '\n' : ''}Command timed out`,
            error: 'SSH command timed out',
            timing: {
              totalMs: Date.now() - startedAt,
              spawnMs: Date.now() - startedAt,
              timedOut: true,
              engine: 'ssh2'
            }
          })
        }, timeout)
        timer.unref?.()
      })
    })
    return result
  } catch (error) {
    return {
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      error: error instanceof Error ? error.message : String(error),
      timing: {
        totalMs: Date.now() - startedAt,
        spawnMs: Date.now() - startedAt,
        timedOut: false,
        engine: 'ssh2'
      }
    }
  } finally {
    if (timer) clearTimeout(timer)
    client?.end()
    jumpClient?.end()
  }
}

async function resolveSshPath(connectionId: string, inputPath: string): Promise<string> {
  const resolvedPath = await withSftp(
    connectionId,
    async (sftp) => await sftpRealPath(sftp, inputPath)
  )
  logSshDebug('remote path resolved', { connectionId, inputPath, resolvedPath })
  return resolvedPath
}

async function connectClient(client: Client, config: ConnectConfig): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client
      .once('ready', () => resolve())
      .once('error', (err) => reject(err))
      .connect(config)
  })
}

async function connectWithProxyJump(
  connection: SshConfigConnection
): Promise<{ client: Client; jumpClient?: Client }> {
  const targetConfig = buildConnectConfig(connection)
  const jumpTarget = await resolveProxyJumpTarget(connection)
  if (!jumpTarget) {
    const client = new Client()
    await connectClient(client, targetConfig)
    return { client }
  }

  const jumpClient = new Client()
  try {
    await connectClient(jumpClient, buildConnectConfig(jumpTarget.connection))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw isAuthFailureMessage(message)
      ? toLayeredError('jump_auth', message, err)
      : toLayeredError('jump_connect', message, err)
  }

  const targetClient = new Client()
  try {
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      jumpClient.forwardOut('127.0.0.1', 0, connection.host, connection.port, (err, channel) => {
        if (err) return reject(err)
        resolve(channel)
      })
    })

    await connectClient(targetClient, { ...targetConfig, sock: stream })
    return { client: targetClient, jumpClient }
  } catch (err) {
    try {
      jumpClient.end()
    } catch {
      // ignore
    }
    const message = err instanceof Error ? err.message : String(err)
    throw isAuthFailureMessage(message)
      ? toLayeredError('target_auth', message, err)
      : toLayeredError('target_connect', message, err)
  }
}

async function withSftp<T>(
  connectionId: string,
  operation: (sftp: SFTPWrapper) => Promise<T>
): Promise<T> {
  const connection = getSshConnection(connectionId)
  if (!connection) throw new Error('Connection not found')
  const connected = await withSshWorkspace(currentSshWorkspaceId(), () =>
    connectWithProxyJump(connection)
  )
  try {
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      connected.client.sftp((error, value) => (error ? reject(error) : resolve(value)))
    })
    return await operation(sftp)
  } finally {
    connected.client.end()
    connected.jumpClient?.end()
  }
}

export function sftpReadFile(sftp: SFTPWrapper, filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(filePath, (error, value) => (error ? reject(error) : resolve(value)))
  })
}

export function sftpWriteFile(
  sftp: SFTPWrapper,
  filePath: string,
  content: string | Buffer
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(filePath, content, (error) => (error ? reject(error) : resolve()))
  })
}

function sftpAppendFile(sftp: SFTPWrapper, filePath: string, content: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.open(filePath, 'a', (openError, handle) => {
      if (openError || !handle) return reject(openError ?? new Error('Remote file open failed'))
      sftp.write(handle, content, 0, content.length, 0, (writeError) => {
        sftp.close(handle, (closeError) => {
          if (writeError) return reject(writeError)
          if (closeError) return reject(closeError)
          resolve()
        })
      })
    })
  })
}

export function sftpReadRange(
  sftp: SFTPWrapper,
  filePath: string,
  offset: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(filePath, 'r', (openError, handle) => {
      if (openError || !handle) return reject(openError ?? new Error('Remote file open failed'))
      sftp.stat(filePath, (statError, stats) => {
        if (statError) {
          sftp.close(handle, () => reject(statError))
          return
        }
        const length = Math.max(0, stats.size - offset)
        const output = Buffer.alloc(length)
        if (length === 0) {
          sftp.close(handle, (closeError) => (closeError ? reject(closeError) : resolve(output)))
          return
        }
        sftp.read(handle, output, 0, length, offset, (readError, bytesRead) => {
          sftp.close(handle, (closeError) => {
            if (readError) return reject(readError)
            if (closeError) return reject(closeError)
            resolve(output.subarray(0, bytesRead))
          })
        })
      })
    })
  })
}

export function sftpMakeDirectory(sftp: SFTPWrapper, directoryPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.stat(directoryPath, (statError, stats) => {
      if (!statError)
        return stats.isDirectory() ? resolve() : reject(new Error('Remote path is not a directory'))
      sftp.mkdir(directoryPath, (error) => (error ? reject(error) : resolve()))
    })
  })
}

export function sftpDeleteFile(sftp: SFTPWrapper, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(filePath, (error) => (error ? reject(error) : resolve()))
  })
}

export function sftpMoveFile(sftp: SFTPWrapper, fromPath: string, toPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(fromPath, toPath, (error) => (error ? reject(error) : resolve()))
  })
}

export function sftpRealPath(sftp: SFTPWrapper, inputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(inputPath, (error, value) => (error ? reject(error) : resolve(value)))
  })
}

export function formatSshTextFileLines(
  content: string,
  filePath: string,
  maxLines: number
): ReadTextFileLinesResult {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  return {
    content: lines.slice(0, maxLines).join('\n'),
    name: path.basename(filePath),
    path: filePath,
    lineCount: lines.length,
    maxLines,
    truncated: lines.length > maxLines
  }
}

export async function uploadSftpPath(
  sftp: SFTPWrapper,
  localPath: string,
  remoteDir: string,
  resume = false
): Promise<number> {
  let bytes = 0
  const upload = async (source: string, destination: string): Promise<void> => {
    const stats = await fs.promises.stat(source)
    if (stats.isDirectory()) {
      await sftpMakeDirectory(sftp, destination)
      for (const entry of await fs.promises.readdir(source)) {
        await upload(path.join(source, entry), path.posix.join(destination, entry))
      }
      return
    }
    const content = await fs.promises.readFile(source)
    let offset = 0
    if (resume) {
      try {
        const existing = await sftpStat(sftp, destination)
        if (existing.size > 0 && existing.size < content.byteLength) offset = existing.size
      } catch {
        // A missing destination starts from zero.
      }
    }
    if (offset > 0) await sftpAppendFile(sftp, destination, content.subarray(offset))
    else await sftpWriteFile(sftp, destination, content)
    bytes += content.byteLength - offset
  }
  await upload(localPath, path.posix.join(remoteDir, path.basename(localPath)))
  return bytes
}

async function uploadLocalPath(
  connectionId: string,
  localPath: string,
  remoteDir: string,
  resume = false
): Promise<number> {
  return await withSftp(
    connectionId,
    async (sftp) => await uploadSftpPath(sftp, localPath, remoteDir, resume)
  )
}

export function sftpStat(sftp: SFTPWrapper, remotePath: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error, value) => (error ? reject(error) : resolve(value)))
  })
}

export async function downloadSftpPath(
  sftp: SFTPWrapper,
  remotePath: string,
  localDir: string,
  resume = false
): Promise<number> {
  let bytes = 0
  const download = async (source: string, destination: string): Promise<void> => {
    const stats = await sftpStat(sftp, source)
    if (stats.isDirectory()) {
      await fs.promises.mkdir(destination, { recursive: true })
      const entries = await new Promise<Parameters<Parameters<SFTPWrapper['readdir']>[1]>[1]>(
        (resolve, reject) => {
          sftp.readdir(source, (error, list) => (error ? reject(error) : resolve(list)))
        }
      )
      for (const entry of entries)
        await download(
          path.posix.join(source, entry.filename),
          path.join(destination, entry.filename)
        )
      return
    }
    await fs.promises.mkdir(path.dirname(destination), { recursive: true })
    let offset = 0
    if (resume) {
      try {
        const existing = await fs.promises.stat(destination)
        if (existing.size > 0 && existing.size < stats.size) offset = existing.size
      } catch {
        // A missing destination starts from zero.
      }
    }
    const content =
      offset > 0 ? await sftpReadRange(sftp, source, offset) : await sftpReadFile(sftp, source)
    if (offset > 0) await fs.promises.appendFile(destination, content)
    else await fs.promises.writeFile(destination, content)
    bytes += content.byteLength - offset
  }
  await download(remotePath, path.join(localDir, path.posix.basename(remotePath)))
  return bytes
}

async function downloadRemotePath(
  connectionId: string,
  remotePath: string,
  localDir: string,
  resume = false
): Promise<number> {
  return await withSftp(
    connectionId,
    async (sftp) => await downloadSftpPath(sftp, remotePath, localDir, resume)
  )
}

export async function copySftpPath(
  sourceSftp: SFTPWrapper,
  targetSftp: SFTPWrapper,
  sourcePath: string,
  targetDir: string,
  resume = false
): Promise<number> {
  let bytes = 0
  const copy = async (source: string, destination: string): Promise<void> => {
    const stats = await sftpStat(sourceSftp, source)
    if (stats.isDirectory()) {
      await sftpMakeDirectory(targetSftp, destination)
      const entries = await new Promise<Parameters<Parameters<SFTPWrapper['readdir']>[1]>[1]>(
        (resolve, reject) => {
          sourceSftp.readdir(source, (error, list) => (error ? reject(error) : resolve(list)))
        }
      )
      for (const entry of entries)
        await copy(
          path.posix.join(source, entry.filename),
          path.posix.join(destination, entry.filename)
        )
      return
    }
    const content = await sftpReadFile(sourceSftp, source)
    let offset = 0
    if (resume) {
      try {
        const existing = await sftpStat(targetSftp, destination)
        if (existing.size > 0 && existing.size < content.byteLength) offset = existing.size
      } catch {
        // A missing destination starts from zero.
      }
    }
    if (offset > 0) await sftpAppendFile(targetSftp, destination, content.subarray(offset))
    else await sftpWriteFile(targetSftp, destination, content)
    bytes += content.byteLength - offset
  }
  await copy(sourcePath, path.posix.join(targetDir, path.posix.basename(sourcePath)))
  return bytes
}

export type SftpTransferScanEntry = {
  path: string
  kind: 'file' | 'directory'
  size: number
}

/** Enumerate a transfer source before execution so callers can preview scope and bytes. */
export async function scanSftpPath(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<{ entries: SftpTransferScanEntry[]; bytes: number }> {
  const entries: SftpTransferScanEntry[] = []
  let bytes = 0
  const scan = async (source: string): Promise<void> => {
    const stats = await sftpStat(sftp, source)
    const directory = stats.isDirectory()
    entries.push({ path: source, kind: directory ? 'directory' : 'file', size: stats.size })
    if (!directory) {
      bytes += stats.size
      return
    }
    const children = await new Promise<Parameters<Parameters<SFTPWrapper['readdir']>[1]>[1]>(
      (resolve, reject) => {
        sftp.readdir(source, (error, list) => (error ? reject(error) : resolve(list)))
      }
    )
    for (const child of children) await scan(path.posix.join(source, child.filename))
  }
  await scan(remotePath)
  return { entries, bytes }
}

async function copyRemotePath(
  sourceConnectionId: string,
  targetConnectionId: string,
  sourcePath: string,
  targetDir: string,
  resume = false
): Promise<number> {
  return await withSftp(
    sourceConnectionId,
    async (sourceSftp) =>
      await withSftp(
        targetConnectionId,
        async (targetSftp) =>
          await copySftpPath(sourceSftp, targetSftp, sourcePath, targetDir, resume)
      )
  )
}

function sftpReadDirectory(sftp: SFTPWrapper, filePath: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(filePath, (error, entries) => {
      if (error) return reject(error)
      resolve(
        entries.map((entry) => ({
          name: entry.filename,
          path: entry.filename,
          type: entry.attrs.isDirectory() ? 'directory' : 'file',
          size: entry.attrs.size,
          mtimeMs: entry.attrs.mtime * 1000
        }))
      )
    })
  })
}

function sftpGlob(
  sftp: SFTPWrapper,
  rootPath: string,
  pattern: string
): Promise<Array<{ path: string; type: 'file' | 'directory' }>> {
  const normalizedPattern = pattern.replaceAll('\\', '/').replace(/^\.\//, '')
  const expression = new RegExp(
    `^${normalizedPattern
      .split('**')
      .map((part) =>
        part
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]')
      )
      .join('(?:.*/)?')}$`
  )
  const results: Array<{ path: string; type: 'file' | 'directory' }> = []
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (results.length >= 1000 || depth > 32) return
    const entries = await new Promise<Parameters<Parameters<SFTPWrapper['readdir']>[1]>[1]>(
      (resolve, reject) => {
        sftp.readdir(directory, (error, list) => (error ? reject(error) : resolve(list)))
      }
    )
    for (const entry of entries) {
      if (results.length >= 1000) break
      const absolute = `${directory.replace(/\/$/, '')}/${entry.filename}`
      const relative = absolute.replace(`${rootPath.replace(/\/$/, '')}/`, '')
      const type = entry.attrs.isDirectory() ? 'directory' : 'file'
      if (expression.test(relative) || expression.test(entry.filename))
        results.push({ path: absolute, type })
      if (type === 'directory') await visit(absolute, depth + 1)
    }
  }
  return visit(rootPath, 0).then(() => results)
}

function recordOutput(session: SshSession, data: Buffer): void {
  session.outputSeq += 1
  const seq = session.outputSeq
  const chunk = Buffer.from(data)

  session.outputBuffer.push({ seq, data: chunk })
  session.outputBufferSize += chunk.length

  while (session.outputBufferSize > MAX_OUTPUT_BUFFER_BYTES && session.outputBuffer.length > 1) {
    const removed = session.outputBuffer.shift()
    if (!removed) break
    session.outputBufferSize -= removed.data.length
  }

  sendSshSessionMessage(session, 'ssh:output', {
    sessionId: session.id,
    data: chunk.toString('base64'),
    seq
  })
}

function redactSshDiagnostic(message: string): string {
  return message
    .replace(/(password|passphrase|token|private[_ -]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----/gi, '[redacted private key]')
    .slice(0, 500)
}

function recordSshDiagnostic(
  session: SshSession,
  stage: 'dial' | 'handshake' | 'auth' | 'shell' | 'reconnect',
  level: 'info' | 'error',
  message: string
): void {
  sshDiagnostics.push({
    id: nextSshDiagnosticId++,
    sessionId: session.id,
    connectionId: session.connectionId,
    workspaceId: session.workspaceId,
    ownerWindowId: session.ownerWindowId,
    stage,
    level,
    message: redactSshDiagnostic(message),
    timestamp: Date.now()
  })
  if (sshDiagnostics.length > MAX_SSH_DIAGNOSTIC_ENTRIES) {
    sshDiagnostics.splice(0, sshDiagnostics.length - MAX_SSH_DIAGNOSTIC_ENTRIES)
  }
}

function scheduleSshReconnect(session: SshSession, connection: SshConfigConnection): void {
  if (session.userInitiatedDisconnect || session.reconnectTimer) return
  if (session.reconnectAttempts >= MAX_SSH_RECONNECT_ATTEMPTS) {
    session.status = 'error'
    session.error = 'Connection lost after 3 reconnect attempts'
    recordSshDiagnostic(session, 'reconnect', 'error', session.error)
    sendSshSessionMessage(session, 'ssh:status', {
      sessionId: session.id,
      connectionId: session.connectionId,
      status: 'error',
      error: session.error
    })
    sshSessions.delete(session.id)
    return
  }

  session.status = 'reconnecting'
  session.reconnectAttempts += 1
  const attempt = session.reconnectAttempts
  recordSshDiagnostic(session, 'reconnect', 'info', `Reconnect attempt ${attempt}`)
  sendSshSessionMessage(session, 'ssh:status', {
    sessionId: session.id,
    connectionId: session.connectionId,
    status: 'reconnecting'
  })
  session.reconnectTimer = setTimeout(
    () => {
      session.reconnectTimer = undefined
      void (async () => {
        try {
          if (
            session.workspaceId !== 'local-personal' &&
            !(await loadOfflineWorkspaceIds()).has(session.workspaceId)
          ) {
            session.userInitiatedDisconnect = true
            session.status = 'disconnected'
            session.client.end()
            session.jumpClient?.end()
            sshSessions.delete(session.id)
            return
          }
          const connected = await withSshWorkspace(session.workspaceId, () =>
            connectWithProxyJump(connection)
          )
          if (session.userInitiatedDisconnect) {
            connected.client.end()
            connected.jumpClient?.end()
            return
          }
          session.client = connected.client
          session.jumpClient = connected.jumpClient
          session.client.on('error', (error) => {
            recordSshDiagnostic(session, 'handshake', 'error', error.message)
            scheduleSshReconnect(session, connection)
          })
          session.client.on('close', () => scheduleSshReconnect(session, connection))
          session.client.shell(
            { term: 'xterm-256color', cols: 120, rows: 30, modes: {} },
            (err, stream) => {
              if (err) {
                recordSshDiagnostic(session, 'shell', 'error', err.message)
                scheduleSshReconnect(session, connection)
                return
              }
              session.shell = stream
              session.status = 'connected'
              session.reconnectAttempts = 0
              recordSshDiagnostic(session, 'shell', 'info', 'Shell restored')
              stream.on('data', (data: Buffer) => recordOutput(session, data))
              stream.stderr?.on('data', (data: Buffer) => recordOutput(session, data))
              stream.on('close', () => scheduleSshReconnect(session, connection))
              sendSshSessionMessage(session, 'ssh:status', {
                sessionId: session.id,
                connectionId: session.connectionId,
                status: 'connected'
              })
            }
          )
        } catch (error) {
          recordSshDiagnostic(session, 'reconnect', 'error', formatLayeredError(error))
          scheduleSshReconnect(session, connection)
        }
      })()
    },
    Math.min(1000 * attempt, 3000)
  )
}

type SshOutputBufferArgs = { sessionId: string; sinceSeq?: number }
type SshReadFileArgs = {
  connectionId: string
  path: string
  offset?: number
  limit?: number
  raw?: boolean
}
type SshReadTextFileLinesArgs = { connectionId: string; path: string; maxLines?: number }
type SshWriteFileArgs = {
  connectionId: string
  path: string
  content: string
  beforeContent?: string
  changeMeta?: { runId?: string; sessionId?: string; toolUseId?: string; toolName?: string }
}
type SshReadFileBinaryArgs = { connectionId: string; path: string }
type SshWriteFileBinaryArgs = { connectionId: string; path: string; data: string }
type SshListDirArgs = {
  connectionId: string
  path: string
  cursor?: string
  limit?: number
  refresh?: boolean
}
type SshExecArgs = { connectionId: string; command: string; timeout?: number }
type SshGlobArgs = { connectionId: string; pattern: string; path?: string; limit?: number }
type SshGrepArgs = Record<string, unknown> & {
  connectionId: string
  pattern: string
  path?: string
}

function isTrustedSshIpcSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  return (
    ownerWindow !== null &&
    !ownerWindow.isDestroyed() &&
    ownerWindow.webContents === event.sender &&
    event.senderFrame === event.sender.mainFrame
  )
}

function registerSshMessagePackHandler<TArgs>(
  channel: string,
  handler: (args: TArgs, event: IpcMainInvokeEvent) => Promise<unknown>
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (event, bytes: Uint8Array) => {
    if (!isTrustedSshIpcSender(event)) {
      return encodeMessagePackPayload({ error: 'Unauthorized SSH IPC sender' })
    }
    let releaseRequest: (() => void) | undefined
    try {
      releaseRequest = sshWorkspaceSwitchGate.beginRequest()
      const args = decodeMessagePackPayload<TArgs>(bytes)
      const rawWorkspaceId = (args as { workspaceId?: unknown } | null)?.workspaceId
      let workspaceId: string
      try {
        workspaceId = await authorizeSshWorkspace(rawWorkspaceId, loadOfflineWorkspaceIds)
      } catch {
        return encodeMessagePackPayload({ error: 'SSH_WORKSPACE_UNAVAILABLE' })
      }
      return encodeMessagePackPayload(
        await withSshWorkspace(workspaceId, async () => {
          await initializeSshConfigCache()
          return handler(args, event)
        })
      )
    } catch (error) {
      if (error instanceof Error && error.message === 'WORKSPACE_BUSY_SSH')
        return encodeMessagePackPayload({ error: 'WORKSPACE_BUSY_SSH' })
      throw error
    } finally {
      releaseRequest?.()
    }
  })
}

async function handleSshOutputBuffer(
  args: SshOutputBufferArgs,
  event: IpcMainInvokeEvent
): Promise<unknown> {
  const session = sshSessions.get(args.sessionId)
  if (!session) return { error: 'Session not found' }
  if (!isSshSessionOwnedBy(event, args.sessionId))
    return { error: 'SSH session is owned by another window' }

  const sinceSeq = args.sinceSeq ?? 0
  const chunks = session.outputBuffer
    .filter((entry) => entry.seq > sinceSeq)
    .map((entry) => entry.data.toString('base64'))

  return {
    lastSeq: session.outputSeq,
    chunks
  }
}

async function handleSshReadFile(args: SshReadFileArgs): Promise<unknown> {
  try {
    const content = await readSshRuntimeText(args.connectionId, args.path)

    // Default to raw; only format with line numbers when raw is explicitly false.
    if (args.raw !== false) {
      return content
    }

    const normalized = content.replace(/\r\n/g, '\n')
    const lines = normalized.split('\n')
    const start = Math.max(0, (args.offset ?? 1) - 1)
    const count = Math.max(0, Math.min(args.limit ?? 2000, 2000))
    const end = Math.min(start + count, lines.length)
    const lineNoWidth = Math.max(6, String(end).length)
    return lines
      .slice(start, end)
      .map((line, i) => `${String(start + i + 1).padStart(lineNoWidth)}\t${line}`)
      .join('\n')
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshReadTextFileLines(args: SshReadTextFileLinesArgs): Promise<unknown> {
  try {
    const maxLines = clampTextLineReadLimit(args.maxLines)
    if (TEXT_READ_BLOCKED_EXTENSIONS.has(path.extname(args.path).toLowerCase())) {
      return { error: 'This file type cannot be read as plain text' }
    }
    const content = await readSshRuntimeText(args.connectionId, args.path)
    return formatSshTextFileLines(content, args.path, maxLines)
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshStatPath(args: { connectionId: string; path: string }): Promise<unknown> {
  try {
    return await withSftp(args.connectionId, async (sftp) => {
      try {
        const stats = await new Promise<Stats>((resolve, reject) => {
          sftp.stat(args.path, (error, value) => (error ? reject(error) : resolve(value)))
        })
        return {
          exists: true,
          type: stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'file',
          size: stats.size,
          mtimeMs: stats.mtime * 1000
        }
      } catch {
        return { exists: false, type: null, size: null, mtimeMs: null }
      }
    })
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshWriteFile(args: SshWriteFileArgs): Promise<unknown> {
  try {
    const before = await readSshTextSnapshot(args.connectionId, args.path)
    if (
      typeof args.beforeContent === 'string' &&
      before.hash !== buildFileSnapshot(true, args.beforeContent).hash
    ) {
      throw new Error(
        'File changed since it was read. Read the file again before editing or writing.'
      )
    }
    await writeSshTextFile(args.connectionId, args.path, args.content)
    await recordSshTextWriteChange({
      meta: args.changeMeta,
      connectionId: args.connectionId,
      filePath: args.path,
      before,
      afterText: args.content
    })
    return { success: true, op: before.exists ? 'modify' : 'create' }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshReadFileBinary(args: SshReadFileBinaryArgs): Promise<unknown> {
  try {
    const data = await withSftp(
      args.connectionId,
      async (sftp) => await sftpReadFile(sftp, args.path)
    )
    return { data: data.toString('base64') }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshWriteFileBinary(args: SshWriteFileBinaryArgs): Promise<unknown> {
  try {
    await withSftp(
      args.connectionId,
      async (sftp) => await sftpWriteFile(sftp, args.path, Buffer.from(args.data, 'base64'))
    )
    return { success: true }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshListDir(args: SshListDirArgs): Promise<unknown> {
  try {
    if (args.cursor) return { error: 'Cursor pagination is not available for SFTP list-dir' }
    const entries = await listSshRuntimeDirectory(args.connectionId, args.path)
    return args.limit
      ? { entries: entries.slice(0, args.limit), hasMore: entries.length > args.limit }
      : entries
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshHomeDir(args: { connectionId: string }): Promise<unknown> {
  try {
    const home = await withSftp(args.connectionId, async (sftp) => await sftpRealPath(sftp, '.'))
    return { path: home }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshFsConnect(
  args: { connectionId: string },
  event: IpcMainInvokeEvent
): Promise<unknown> {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  if (!ownerWindow || ownerWindow.isDestroyed()) return { error: 'SSH window is unavailable' }
  const ticket = sftpWorkspaceActivity.beginConnect(
    ownerWindow.id,
    args.connectionId,
    currentSshWorkspaceId()
  )
  try {
    const result = await handleSshHomeDir(args)
    if (
      currentSshWorkspaceId() !== 'local-personal' &&
      !(await loadOfflineWorkspaceIds()).has(currentSshWorkspaceId())
    ) {
      sftpWorkspaceActivity.finishConnect(ticket, false)
      return { error: 'SSH_WORKSPACE_UNAVAILABLE' }
    }
    const success = !('error' in (result as Record<string, unknown>))
    sftpWorkspaceActivity.finishConnect(ticket, success)
    return success ? { success: true, homeDir: (result as { path?: string }).path ?? null } : result
  } catch (err) {
    sftpWorkspaceActivity.finishConnect(ticket, false)
    return { error: String(err) }
  }
}

async function handleSshFsDisconnect(
  args: { connectionId: string },
  event: IpcMainInvokeEvent
): Promise<unknown> {
  try {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender)
    if (!ownerWindow || ownerWindow.isDestroyed()) return { error: 'SSH window is unavailable' }
    sftpWorkspaceActivity.disconnect(ownerWindow.id, args.connectionId, currentSshWorkspaceId())
    logSshDebug('SFTP disconnect requested', { connectionId: args.connectionId })
    return { success: true }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshMkdir(args: { connectionId: string; path: string }): Promise<unknown> {
  try {
    await withSftp(args.connectionId, async (sftp) => await sftpMakeDirectory(sftp, args.path))
    return { success: true }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshDelete(args: { connectionId: string; path: string }): Promise<unknown> {
  try {
    await deleteSshFile(args.connectionId, args.path)
    return { success: true }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshMove(args: {
  connectionId: string
  from: string
  to: string
}): Promise<unknown> {
  try {
    await withSftp(args.connectionId, async (sftp) => await sftpMoveFile(sftp, args.from, args.to))
    return { success: true }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshExec(args: SshExecArgs): Promise<unknown> {
  try {
    const result = await execSshCommand(args.connectionId, args.command, args.timeout)
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr || result.error || ''
    }
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshGlob(args: SshGlobArgs): Promise<unknown> {
  try {
    return await globSshRuntimeFiles(args.connectionId, args.pattern, args.path || '.')
  } catch (err) {
    return { error: String(err) }
  }
}

async function handleSshGrep(args: SshGrepArgs): Promise<unknown> {
  try {
    const { connectionId, ...params } = args
    return await grepSshRuntimeFiles(connectionId, { ...params, path: args.path || '.' })
  } catch (err) {
    return { error: String(err) }
  }
}

export async function registerSshHandlers(): Promise<void> {
  if (!accountRevocationSubscribed) {
    accountRevocationSubscribed = true
    onRemoteAccountCleared(revokeManagedSshWorkspaceActivity)
    onWorkspaceDirectoryChanged(revokeUnavailableSshWorkspaceActivity)
  }
  registerSshChangeAdapter({
    readSnapshot: readSshTextSnapshot,
    writeText: writeSshTextFile,
    deleteFile: deleteSshFile
  })
  await initializeSshConfigCache()
  ensureSshConfigWatcher()

  // ── Group CRUD ──

  registerSshMessagePackHandler<void>('ssh:group:list', async () => {
    try {
      return listSshGroups().map(toGroupRow)
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerSshMessagePackHandler<{ id: string; name: string; sortOrder?: number }>(
    'ssh:group:create',
    async (args) => {
      try {
        const now = Date.now()
        await createSshGroup({
          id: args.id,
          name: args.name,
          sortOrder: args.sortOrder ?? 0,
          createdAt: now,
          updatedAt: now
        })
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  registerSshMessagePackHandler<{ connectionId: string; publicKey: string }>(
    'ssh:auth:install-public-key',
    async (args) => {
      try {
        const publicKey = (args.publicKey ?? '').trim()
        if (!publicKey) return { error: 'Public key is empty' }

        const cmd =
          `mkdir -p ~/.ssh && ` +
          `chmod 700 ~/.ssh && ` +
          `touch ~/.ssh/authorized_keys && ` +
          `chmod 600 ~/.ssh/authorized_keys && ` +
          `printf %s\\n ${shellEscape(publicKey)} >> ~/.ssh/authorized_keys`
        const result = await sshExec({ connectionId: args.connectionId }, cmd, 15000)
        if (result.exitCode !== 0) {
          throw new Error(result.stderr || 'Failed to install public key')
        }

        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SSH: Zip directory (remote) ──

  registerSshMessagePackHandler<{ connectionId: string; dirPath: string }>(
    'ssh:fs:zip-dir',
    async (args) => {
      try {
        const sshSession: SshClientSession = { connectionId: args.connectionId }
        const resolvedDir = await resolveSshPath(args.connectionId, args.dirPath)
        const parent = path.posix.dirname(resolvedDir)
        const base = path.posix.basename(resolvedDir)
        const outName = `${base}-${nowStamp()}-${Math.random().toString(36).slice(2, 6)}.zip`
        const outPath = parent === '/' ? `/${outName}` : `${parent}/${outName}`

        const hasZip = await checkRemoteCommandExists(sshSession, 'zip')
        if (!hasZip) {
          return {
            error:
              'Remote zip not found. Please install zip (e.g. sudo apt-get install zip / yum install zip).'
          }
        }

        const cmd = `cd ${shellEscape(parent)} && zip -r ${shellEscape(outName)} ${shellEscape(base)} >/dev/null`
        const execResult = await sshExec(sshSession, cmd, 10 * 60_000)
        if (execResult.exitCode !== 0) {
          return { error: execResult.stderr || 'Zip failed' }
        }
        return { outputPath: outPath }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SSH: Upload (file/folder) with progress events ──

  registerSshMessagePackHandler<{
    connectionId: string
    remoteDir: string
    localPath: string
    kind?: 'file' | 'folder'
  }>('ssh:fs:upload:start', async (args, event) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender)
    if (!ownerWindow) return { error: 'SSH task owner is unavailable' }
    const taskId = `ssh-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    try {
      const localStat = await fs.promises.stat(args.localPath)
      if (
        currentSshWorkspaceId() !== 'local-personal' &&
        !(await loadOfflineWorkspaceIds()).has(currentSshWorkspaceId())
      )
        return { error: 'SSH_WORKSPACE_UNAVAILABLE' }
      const kind: 'file' | 'folder' = args.kind
        ? args.kind
        : localStat.isDirectory()
          ? 'folder'
          : 'file'

      const task: UploadTaskState = {
        taskId,
        connectionId: args.connectionId,
        workspaceId: currentSshWorkspaceId(),
        ownerWindowId: ownerWindow.id,
        canceled: false,
        started: false,
        cancel: async (): Promise<void> => {
          if (task.canceled) return
          task.canceled = true
          sendUploadEvent({
            taskId,
            connectionId: args.connectionId,
            stage: 'canceled',
            message: 'Canceled'
          })
        }
      }
      uploadTasks.set(taskId, task)

      if (kind === 'file') {
        void (async () => {
          try {
            if (task.canceled) return
            sendUploadEvent({
              taskId,
              connectionId: args.connectionId,
              stage: 'upload',
              progress: { current: 0, total: localStat.size, percent: 0 },
              message: 'Uploading...'
            })

            task.started = true
            const bytes = await uploadLocalPath(args.connectionId, args.localPath, args.remoteDir)
            if (task.canceled) return
            sendUploadEvent({
              taskId,
              connectionId: args.connectionId,
              stage: 'done',
              progress: {
                current: bytes,
                total: localStat.size,
                percent: 100
              },
              message: 'Upload complete'
            })
          } catch (err) {
            sendUploadEvent({
              taskId,
              connectionId: args.connectionId,
              stage: task.canceled ? 'canceled' : 'error',
              message: String(err)
            })
          } finally {
            uploadTasks.delete(taskId)
          }
        })()

        return { taskId }
      }

      void (async () => {
        try {
          if (task.canceled) return
          sendUploadEvent({
            taskId,
            connectionId: args.connectionId,
            stage: 'upload',
            message: 'Preparing upload...'
          })

          task.started = true
          const bytes = await uploadLocalPath(args.connectionId, args.localPath, args.remoteDir)
          if (task.canceled) return
          sendUploadEvent({
            taskId,
            connectionId: args.connectionId,
            stage: 'done',
            progress: { current: bytes, total: bytes, percent: 100 },
            message: 'Upload complete'
          })
        } catch (err) {
          sendUploadEvent({
            taskId,
            connectionId: args.connectionId,
            stage: task.canceled ? 'canceled' : 'error',
            message: String(err)
          })
        } finally {
          uploadTasks.delete(taskId)
        }
      })()

      return { taskId }
    } catch (err) {
      uploadTasks.delete(taskId)
      return { error: String(err) }
    }
  })

  registerSshMessagePackHandler<{ taskId: string }>('ssh:fs:upload:cancel', async (args, event) => {
    const task = uploadTasks.get(args.taskId)
    if (!task) return { error: 'Task not found' }
    if (!isSshTaskOwnedBy(event, task.ownerWindowId)) {
      return { error: 'SSH task is owned by another window' }
    }
    try {
      await task.cancel('Canceled by user')
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // Compatibility aliases for the former Worker-specific abort entrypoints. All
  // transfer cancellation is decided by the shared TS task registry.
  for (const channel of [
    'ssh:fs:upload:abort',
    'ssh:fs:download:abort',
    'ssh:fs:remote-copy:abort'
  ]) {
    registerSshMessagePackHandler<{ taskId: string }>(channel, async (args, event) => {
      const task = transferTasks.get(args.taskId) ?? uploadTasks.get(args.taskId)
      if (!task) return { error: 'Task not found' }
      if (!isSshTaskOwnedBy(event, task.ownerWindowId)) {
        return { error: 'SSH task is owned by another window' }
      }
      try {
        await task.cancel('Canceled by user')
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    })
  }

  registerSshMessagePackHandler<{
    connectionId: string
    remotePaths: string[]
  }>('ssh:fs:transfer:scan', async (args) => {
    try {
      const scans = await withSftp(args.connectionId, async (sftp) =>
        Promise.all(args.remotePaths.map((remotePath) => scanSftpPath(sftp, remotePath)))
      )
      return {
        entries: scans.flatMap((scan) => scan.entries),
        bytes: scans.reduce((total, scan) => total + scan.bytes, 0)
      }
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerSshMessagePackHandler<
    | {
        type: 'upload'
        connectionId: string
        remoteDir: string
        localPaths: string[]
        conflictPolicy?: SshConflictPolicy
        resume?: boolean
      }
    | {
        type: 'download'
        connectionId: string
        remotePaths: string[]
        localDir: string
        conflictPolicy?: SshConflictPolicy
        resume?: boolean
      }
    | {
        type: 'remote-copy'
        sourceConnectionId: string
        targetConnectionId: string
        sourcePaths: string[]
        targetDir: string
        conflictPolicy?: SshConflictPolicy
        resume?: boolean
      }
  >('ssh:fs:transfer:start', async (args, event) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender)
    if (!ownerWindow) return { error: 'SSH task owner is unavailable' }
    const taskId = `ssh-transfer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const conflictPolicy = args.conflictPolicy ?? 'skip'

    try {
      logSshDebug('transfer start', {
        taskId,
        type: args.type,
        conflictPolicy,
        sourceConnectionId:
          args.type === 'remote-copy' ? args.sourceConnectionId : args.connectionId,
        targetConnectionId:
          args.type === 'upload'
            ? args.connectionId
            : args.type === 'remote-copy'
              ? args.targetConnectionId
              : null,
        itemCount:
          args.type === 'upload'
            ? args.localPaths.length
            : args.type === 'download'
              ? args.remotePaths.length
              : args.sourcePaths.length
      })

      const task: TransferTaskState = {
        taskId,
        type: args.type,
        workspaceId: currentSshWorkspaceId(),
        ownerWindowId: ownerWindow.id,
        sourceConnectionId:
          args.type === 'remote-copy' ? args.sourceConnectionId : args.connectionId,
        targetConnectionId:
          args.type === 'upload'
            ? args.connectionId
            : args.type === 'remote-copy'
              ? args.targetConnectionId
              : null,
        canceled: false,
        started: false,
        cancel: async () => {
          if (task.canceled) return
          task.canceled = true
          sendTransferEvent({
            taskId,
            type: args.type,
            stage: 'canceled',
            sourceConnectionId: task.sourceConnectionId ?? null,
            targetConnectionId: task.targetConnectionId ?? null,
            message: 'Canceled by user',
            conflictPolicy
          })
        }
      }

      transferTasks.set(taskId, task)

      void (async () => {
        try {
          if (task.canceled) return
          if (args.type === 'upload') {
            if (!Array.isArray(args.localPaths) || args.localPaths.length === 0) {
              throw new Error('No local paths selected for upload')
            }

            task.started = true
            for (const localPath of args.localPaths) {
              await uploadLocalPath(
                args.connectionId,
                localPath,
                args.remoteDir,
                args.resume === true
              )
              if (task.canceled) return
            }
            if (task.canceled) {
              return
            }
            sendTransferEvent({
              taskId,
              type: task.type,
              stage: 'done',
              sourceConnectionId: task.sourceConnectionId ?? null,
              targetConnectionId: task.targetConnectionId ?? null,
              message: 'Upload complete',
              conflictPolicy
            })
            return
          } else if (args.type === 'download') {
            if (!Array.isArray(args.remotePaths) || args.remotePaths.length === 0) {
              throw new Error('No remote paths selected for download')
            }

            task.started = true
            for (const remotePath of args.remotePaths) {
              await downloadRemotePath(
                args.connectionId,
                remotePath,
                args.localDir,
                args.resume === true
              )
              if (task.canceled) return
            }
            if (task.canceled) {
              return
            }
            sendTransferEvent({
              taskId,
              type: task.type,
              stage: 'done',
              sourceConnectionId: task.sourceConnectionId ?? null,
              targetConnectionId: task.targetConnectionId ?? null,
              message: 'Download complete',
              conflictPolicy
            })
            return
          } else {
            if (!Array.isArray(args.sourcePaths) || args.sourcePaths.length === 0) {
              throw new Error('No remote paths selected for copy')
            }

            task.started = true
            for (const sourcePath of args.sourcePaths) {
              await copyRemotePath(
                args.sourceConnectionId,
                args.targetConnectionId,
                sourcePath,
                args.targetDir,
                args.resume === true
              )
              if (task.canceled) return
            }
            if (task.canceled) {
              return
            }
            sendTransferEvent({
              taskId,
              type: task.type,
              stage: 'done',
              sourceConnectionId: task.sourceConnectionId ?? null,
              targetConnectionId: task.targetConnectionId ?? null,
              message: 'Remote copy complete',
              conflictPolicy
            })
            return
          }
        } catch (err) {
          sendTransferEvent({
            taskId,
            type: task.type,
            stage: task.canceled ? 'canceled' : 'error',
            sourceConnectionId: task.sourceConnectionId ?? null,
            targetConnectionId: task.targetConnectionId ?? null,
            message: task.canceled ? 'Transfer canceled' : String(err),
            conflictPolicy
          })
        } finally {
          transferTasks.delete(taskId)
        }
      })()

      return { taskId }
    } catch (err) {
      transferTasks.delete(taskId)
      return { error: String(err) }
    }
  })

  registerSshMessagePackHandler<{ taskId: string }>(
    'ssh:fs:transfer:cancel',
    async (args, event) => {
      const task = transferTasks.get(args.taskId)
      if (!task) return { error: 'Task not found' }
      if (!isSshTaskOwnedBy(event, task.ownerWindowId)) {
        return { error: 'SSH task is owned by another window' }
      }
      try {
        logSshDebug('transfer cancel requested', {
          taskId: args.taskId,
          type: task.type,
          sourceConnectionId: task.sourceConnectionId ?? null,
          targetConnectionId: task.targetConnectionId ?? null
        })
        await task.cancel('Canceled by user')
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  registerSshMessagePackHandler<{ id: string; name?: string; sortOrder?: number }>(
    'ssh:group:update',
    async (args) => {
      try {
        await updateSshGroup(args.id, {
          name: args.name,
          sortOrder: args.sortOrder,
          updatedAt: Date.now()
        })
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  registerSshMessagePackHandler<{ id: string }>('ssh:group:delete', async (args) => {
    try {
      await deleteSshGroup(args.id)
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // ── Connection CRUD ──

  registerSshMessagePackHandler<void>('ssh:connection:list', async () => {
    try {
      return listSshConnections().map(toConnectionRow)
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerSshMessagePackHandler<{
    id: string
    groupId?: string
    name: string
    host: string
    port?: number
    username: string
    authType?: string
    password?: string
    privateKeyPath?: string
    passphrase?: string
    startupCommand?: string
    defaultDirectory?: string
    proxyJump?: string
    keepAliveInterval?: number
    sortOrder?: number
  }>('ssh:connection:create', async (args) => {
    try {
      const now = Date.now()
      const connection: SshConfigConnection = {
        id: args.id,
        groupId: args.groupId ?? null,
        name: args.name,
        host: args.host,
        port: args.port ?? 22,
        username: args.username,
        authType: (args.authType as SshConfigConnection['authType']) ?? 'password',
        password: args.password ?? null,
        privateKeyPath: args.privateKeyPath ?? null,
        passphrase: args.passphrase ?? null,
        startupCommand: args.startupCommand ?? null,
        defaultDirectory: args.defaultDirectory ?? null,
        proxyJump: args.proxyJump ?? null,
        keepAliveInterval: args.keepAliveInterval ?? 60,
        sortOrder: args.sortOrder ?? 0,
        lastConnectedAt: null,
        createdAt: now,
        updatedAt: now
      }
      await createSshConnection(connection)
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerSshMessagePackHandler<{
    id: string
    groupId?: string | null
    name?: string
    host?: string
    port?: number
    username?: string
    authType?: string
    password?: string | null
    privateKeyPath?: string | null
    passphrase?: string | null
    startupCommand?: string | null
    defaultDirectory?: string | null
    proxyJump?: string | null
    keepAliveInterval?: number
    sortOrder?: number
  }>('ssh:connection:update', async (args) => {
    try {
      const patch: Partial<Omit<SshConfigConnection, 'id'>> = { updatedAt: Date.now() }
      if (args.groupId !== undefined) patch.groupId = args.groupId
      if (args.name !== undefined) patch.name = args.name
      if (args.host !== undefined) patch.host = args.host
      if (args.port !== undefined) patch.port = args.port
      if (args.username !== undefined) patch.username = args.username
      if (args.authType !== undefined) {
        patch.authType = args.authType as SshConfigConnection['authType']
      }
      if (args.password !== undefined) patch.password = args.password
      if (args.privateKeyPath !== undefined) patch.privateKeyPath = args.privateKeyPath
      if (args.passphrase !== undefined) patch.passphrase = args.passphrase
      if (args.startupCommand !== undefined) patch.startupCommand = args.startupCommand
      if (args.defaultDirectory !== undefined) patch.defaultDirectory = args.defaultDirectory
      if (args.proxyJump !== undefined) patch.proxyJump = args.proxyJump
      if (args.keepAliveInterval !== undefined) patch.keepAliveInterval = args.keepAliveInterval
      if (args.sortOrder !== undefined) patch.sortOrder = args.sortOrder

      await updateSshConnection(args.id, patch)
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  registerSshMessagePackHandler<{ id: string }>('ssh:connection:delete', async (args) => {
    try {
      await deleteSshConnection(args.id)
      // A connection ID can also exist in another workspace; only its own sessions are removed.
      for (const [sessionId, session] of sshSessionsForConnection(
        sshSessions,
        args.id,
        currentSshWorkspaceId()
      )) {
        session.userInitiatedDisconnect = true
        session.status = 'disconnected'
        if (session.reconnectTimer) clearTimeout(session.reconnectTimer)
        session.shell?.end()
        session.client.end()
        session.jumpClient?.end()
        sshSessions.delete(sessionId)
      }
      sftpWorkspaceActivity.forgetConnection(args.id, currentSshWorkspaceId())
      return { success: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // ── Test Connection ──

  registerSshMessagePackHandler<{ id: string }>('ssh:connection:test', async (args) => {
    try {
      await withSftp(args.id, async (sftp) => {
        await new Promise<void>((resolve, reject) => {
          sftp.realpath('.', (error) => (error ? reject(error) : resolve()))
        })
      })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  registerSshMessagePackHandler<{ filePath: string; connectionIds?: string[] | null }>(
    'ssh:export',
    async (args) => {
      try {
        await exportSshConfig(args.filePath, args.connectionIds ?? undefined)
        return { success: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  registerSshMessagePackHandler<{ filePath: string; source: SshImportSource }>(
    'ssh:import:preview',
    async (args) => {
      try {
        return await previewSshImport(args.filePath, args.source)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  registerSshMessagePackHandler<{
    filePath: string
    source: SshImportSource
    decisions: Array<{ importId: string; action: SshImportAction }>
  }>('ssh:import:apply', async (args) => {
    try {
      return await applySshImport(args.filePath, args.source, args.decisions)
    } catch (err) {
      return { error: String(err) }
    }
  })

  // ── Terminal Session: Connect ──

  registerSshMessagePackHandler<{ connectionId: string }>('ssh:connect', async (args, event) => {
    try {
      const connection = getSshConnection(args.connectionId)
      if (!connection) return { error: 'Connection not found' }

      const ownerWindow = BrowserWindow.fromWebContents(event.sender)
      if (!ownerWindow) return { error: 'SSH session owner is unavailable' }
      const sessionId = `ssh-${nextSessionId++}`

      const session: SshSession = {
        id: sessionId,
        connectionId: args.connectionId,
        workspaceId: currentSshWorkspaceId(),
        ownerWindowId: ownerWindow.id,
        client: new Client(),
        shell: null,
        status: 'connecting',
        outputSeq: 0,
        outputBuffer: [],
        outputBufferSize: 0,
        userInitiatedDisconnect: false,
        reconnectAttempts: 0
      }
      sshSessions.set(sessionId, session)
      recordSshDiagnostic(session, 'dial', 'info', 'Connection started')

      sendSshSessionMessage(session, 'ssh:status', {
        sessionId,
        connectionId: args.connectionId,
        status: 'connecting'
      })

      return new Promise((resolve) => {
        const connectTimeout = setTimeout(() => {
          session.status = 'error'
          session.error = 'Connection timeout (30s)'
          session.client.end()
          sshSessions.delete(sessionId)
          sendSshSessionMessage(session, 'ssh:status', {
            sessionId,
            connectionId: args.connectionId,
            status: 'error',
            error: 'Connection timeout (30s)'
          })
          resolve({ error: 'Connection timeout (30s)' })
        }, 30000)

        void (async () => {
          try {
            const connected = await connectWithProxyJump(connection)
            clearTimeout(connectTimeout)
            if (
              session.userInitiatedDisconnect ||
              !sshSessions.has(sessionId) ||
              (session.workspaceId !== 'local-personal' &&
                !(await loadOfflineWorkspaceIds()).has(session.workspaceId))
            ) {
              connected.client.end()
              connected.jumpClient?.end()
              sshSessions.delete(sessionId)
              resolve({ error: 'SSH_WORKSPACE_UNAVAILABLE' })
              return
            }
            session.client = connected.client
            session.jumpClient = connected.jumpClient
            session.status = 'connected'
            recordSshDiagnostic(session, 'handshake', 'info', 'Secure connection established')

            session.client.on('error', (err) => {
              session.error = formatLayeredError(err, connection.authType)
              recordSshDiagnostic(session, 'handshake', 'error', session.error)
              scheduleSshReconnect(session, connection)
            })

            session.client.on('close', () => {
              session.jumpClient?.end()
              scheduleSshReconnect(session, connection)
            })

            await updateSshConnection(args.connectionId, {
              lastConnectedAt: Date.now(),
              updatedAt: Date.now()
            })

            session.client.shell(
              {
                term: 'xterm-256color',
                cols: 120,
                rows: 30,
                modes: {}
              },
              (err, stream) => {
                if (err) {
                  session.status = 'error'
                  session.error = `Shell error: ${err.message}`
                  sendSshSessionMessage(session, 'ssh:status', {
                    sessionId,
                    connectionId: args.connectionId,
                    status: 'error',
                    error: session.error
                  })
                  resolve({ error: session.error })
                  return
                }

                session.shell = stream
                recordSshDiagnostic(session, 'shell', 'info', 'Interactive shell opened')

                stream.on('data', (data: Buffer) => {
                  recordOutput(session, data)
                })

                stream.stderr?.on('data', (data: Buffer) => {
                  recordOutput(session, data)
                })

                stream.on('close', () => {
                  session.client.end()
                  session.jumpClient?.end()
                  scheduleSshReconnect(session, connection)
                })

                sendSshSessionMessage(session, 'ssh:status', {
                  sessionId,
                  connectionId: args.connectionId,
                  status: 'connected'
                })

                if (connection.startupCommand) {
                  stream.write(connection.startupCommand + '\n')
                }
                if (connection.defaultDirectory) {
                  stream.write(`cd ${connection.defaultDirectory}\n`)
                }

                resolve({ sessionId })
              }
            )
          } catch (err) {
            clearTimeout(connectTimeout)
            session.status = 'error'
            session.error = formatLayeredError(err, connection.authType)
            recordSshDiagnostic(
              session,
              isAuthFailureMessage(session.error) ? 'auth' : 'dial',
              'error',
              session.error
            )
            sshSessions.delete(sessionId)
            sendSshSessionMessage(session, 'ssh:status', {
              sessionId,
              connectionId: args.connectionId,
              status: 'error',
              error: session.error
            })
            resolve({ error: session.error })
          }
        })()
      })
    } catch (err) {
      return { error: String(err) }
    }
  })

  // ── Terminal Session: Send data ──

  const handleSshData = (args: { sessionId: string; data: string }): void => {
    const session = sshSessions.get(args.sessionId)
    if (session?.shell && session.status === 'connected') {
      session.shell.write(args.data)
    }
  }

  ipcMain.on(toMessagePackChannel('ssh:data'), (event, bytes: Uint8Array) => {
    if (!isTrustedSshIpcSender(event)) return
    const args = decodeMessagePackPayload<{
      sessionId: string
      data: string
      workspaceId?: string
    }>(bytes)
    if (!isSshSessionOwnedBy(event, args.sessionId, args.workspaceId ?? 'local-personal')) return
    handleSshData(args)
  })

  // ── Terminal Session: Resize PTY ──

  const handleSshResize = (args: { sessionId: string; cols: number; rows: number }): void => {
    const session = sshSessions.get(args.sessionId)
    if (session?.shell && session.status === 'connected') {
      session.shell.setWindow(args.rows, args.cols, 0, 0)
    }
  }

  ipcMain.on(toMessagePackChannel('ssh:resize'), (event, bytes: Uint8Array) => {
    if (!isTrustedSshIpcSender(event)) return
    const args = decodeMessagePackPayload<{
      sessionId: string
      cols: number
      rows: number
      workspaceId?: string
    }>(bytes)
    if (!isSshSessionOwnedBy(event, args.sessionId, args.workspaceId ?? 'local-personal')) return
    handleSshResize(args)
  })

  // ── Terminal Session: Disconnect ──

  registerSshMessagePackHandler<{ sessionId: string }>('ssh:disconnect', async (args, event) => {
    const session = sshSessions.get(args.sessionId)
    if (!session) return { error: 'Session not found' }
    if (!isSshSessionOwnedBy(event, args.sessionId)) {
      return { error: 'SSH session is owned by another window' }
    }

    session.userInitiatedDisconnect = true
    session.status = 'disconnected'
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer)
    if (session.shell) session.shell.end()
    session.client.end()
    sshSessions.delete(args.sessionId)

    sendSshSessionMessage(session, 'ssh:status', {
      sessionId: args.sessionId,
      connectionId: session.connectionId,
      status: 'disconnected'
    })

    return { success: true }
  })

  // ── Terminal Session: List active sessions ──

  registerSshMessagePackHandler<void>('ssh:session:list', async (_args, event) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender)
    if (!ownerWindow) return []
    const list: { id: string; connectionId: string; status: string; error?: string }[] = []
    for (const session of sshSessions.values()) {
      if (
        session.ownerWindowId !== ownerWindow.id ||
        session.workspaceId !== currentSshWorkspaceId()
      )
        continue
      list.push({
        id: session.id,
        connectionId: session.connectionId,
        status: session.status,
        error: session.error
      })
    }
    return list
  })

  registerSshMessagePackHandler<void>('ssh:workspace-activity', async () => ({
    busy: hasActiveMainSshWorkspaceActivity()
  }))

  registerSshMessagePackHandler<{ connectionId?: string }>(
    'ssh:diagnostics:list',
    async (args, event) => {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender)
      if (!ownerWindow) return { entries: [] }
      return {
        entries: sshDiagnostics.filter(
          (entry) =>
            entry.ownerWindowId === ownerWindow.id &&
            entry.workspaceId === currentSshWorkspaceId() &&
            (!args?.connectionId || entry.connectionId === args.connectionId)
        )
      }
    }
  )

  // ── Terminal Session: Output buffer ──

  registerSshMessagePackHandler<SshOutputBufferArgs>('ssh:output:buffer', handleSshOutputBuffer)

  // ── SSH FS: Read file ──

  registerSshMessagePackHandler<SshReadFileArgs>('ssh:fs:read-file', handleSshReadFile)
  registerSshMessagePackHandler<SshReadTextFileLinesArgs>(
    'ssh:fs:read-text-file-lines',
    handleSshReadTextFileLines
  )

  // ── SSH FS: Write file ──

  registerSshMessagePackHandler<{ connectionId: string; path: string }>(
    'ssh:fs:stat-path',
    handleSshStatPath
  )
  registerSshMessagePackHandler<SshWriteFileArgs>('ssh:fs:write-file', handleSshWriteFile)

  // ── SSH FS: Read binary file ──

  registerSshMessagePackHandler<SshReadFileBinaryArgs>(
    'ssh:fs:read-file-binary',
    handleSshReadFileBinary
  )

  // ── SSH FS: Write binary file ──

  registerSshMessagePackHandler<SshWriteFileBinaryArgs>(
    'ssh:fs:write-file-binary',
    handleSshWriteFileBinary
  )

  // ── SSH FS: List directory ──

  registerSshMessagePackHandler<SshListDirArgs>('ssh:fs:list-dir', handleSshListDir)
  registerSshMessagePackHandler<{ connectionId: string }>('ssh:fs:home-dir', handleSshHomeDir)
  registerSshMessagePackHandler<{ connectionId: string }>('ssh:fs:connect', handleSshFsConnect)
  registerSshMessagePackHandler<{ connectionId: string }>(
    'ssh:fs:disconnect',
    handleSshFsDisconnect
  )

  registerSshMessagePackHandler<{ connectionId: string; remotePath: string; localPath: string }>(
    'ssh:fs:download',
    async (args) => {
      try {
        const data = await withSftp(
          args.connectionId,
          async (sftp) => await sftpReadFile(sftp, args.remotePath)
        )
        await fs.promises.writeFile(args.localPath, data)
        return { success: true, path: args.localPath, bytes: data.byteLength }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // ── SSH FS: Mkdir ──

  registerSshMessagePackHandler<{ connectionId: string; path: string }>(
    'ssh:fs:mkdir',
    handleSshMkdir
  )

  // ── SSH FS: Delete ──

  registerSshMessagePackHandler<{ connectionId: string; path: string }>(
    'ssh:fs:delete',
    handleSshDelete
  )

  // ── SSH FS: Move/Rename ──

  registerSshMessagePackHandler<{ connectionId: string; from: string; to: string }>(
    'ssh:fs:move',
    handleSshMove
  )

  // ── SSH Exec (non-interactive command) ──

  registerSshMessagePackHandler<SshExecArgs>('ssh:exec', handleSshExec)

  // ── SSH Glob (via remote find) ──

  registerSshMessagePackHandler<SshGlobArgs>('ssh:fs:glob', handleSshGlob)

  // ── SSH Grep (via remote grep) ──

  registerSshMessagePackHandler<SshGrepArgs>('ssh:fs:grep', handleSshGrep)
}

// ── Helpers ──

function sshExec(
  session: SshClientSession,
  command: string,
  timeout = 60000
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return execSshCommand(session.connectionId, command, timeout).then((result) => ({
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr || result.error || ''
  }))
}

function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'"
}

async function readSshTextSnapshot(connectionId: string, filePath: string): Promise<FileSnapshot> {
  return await withSftp(connectionId, async (sftp) => {
    let stats
    try {
      stats = await new Promise<Stats>((resolve, reject) => {
        sftp.stat(filePath, (error, value) => (error ? reject(error) : resolve(value)))
      })
    } catch {
      return buildFileSnapshot(false)
    }
    if (stats.isDirectory()) return buildOpaqueExistingSnapshot()
    const content = await sftpReadFile(sftp, filePath)
    return buildFileSnapshot(true, content.toString('utf8'))
  })
}

async function writeSshTextFile(
  connectionId: string,
  filePath: string,
  content: string
): Promise<void> {
  await withSftp(connectionId, async (sftp) => await sftpWriteFile(sftp, filePath, content))
}

async function deleteSshFile(connectionId: string, filePath: string): Promise<void> {
  await withSftp(connectionId, async (sftp) => await sftpDeleteFile(sftp, filePath))
}

/** Narrow Main-owned SSH filesystem primitives used by the TS agent runtime. */
export async function readSshRuntimeFile(
  connectionId: string,
  filePath: string,
  offset = 1,
  limit = 2000
): Promise<string> {
  const content = await withSftp(connectionId, async (sftp) => await sftpReadFile(sftp, filePath))
  const lines = content.toString('utf8').replace(/\r\n/g, '\n').split('\n')
  const start = Math.max(0, offset - 1)
  const end = Math.min(lines.length, start + Math.max(1, Math.min(limit, 2000)))
  return lines
    .slice(start, end)
    .map((line, index) => `${String(start + index + 1).padStart(6)}\t${line}`)
    .join('\n')
}

export async function readSshRuntimeText(connectionId: string, filePath: string): Promise<string> {
  const content = await withSftp(connectionId, async (sftp) => await sftpReadFile(sftp, filePath))
  return content.toString('utf8')
}

export async function writeSshRuntimeFile(
  connectionId: string,
  filePath: string,
  content: string
): Promise<void> {
  await withSftp(connectionId, async (sftp) => await sftpWriteFile(sftp, filePath, content))
}

export async function listSshRuntimeDirectory(
  connectionId: string,
  filePath: string
): Promise<unknown[]> {
  return await withSftp(connectionId, async (sftp) => {
    const entries = await sftpReadDirectory(sftp, filePath)
    return entries.slice(0, 1000)
  })
}

export async function globSshRuntimeFiles(
  connectionId: string,
  pattern: string,
  filePath = '.'
): Promise<unknown> {
  return await withSftp(connectionId, async (sftp) => {
    const matches = await sftpGlob(sftp, filePath, pattern)
    return {
      kind: 'glob',
      matches,
      meta: {
        backend: 'ssh',
        engine: 'ssh2-sftp',
        searchRoot: filePath,
        pathStyle: 'absolute',
        truncated: matches.length >= 1000,
        timedOut: false,
        limitReason: matches.length >= 1000 ? 'max_results' : null,
        pattern,
        hiddenIncluded: true,
        ignoredDefaultsApplied: false
      }
    } satisfies SshGlobResult
  })
}

export async function grepSshRuntimeFiles(
  connectionId: string,
  input: Record<string, unknown>
): Promise<unknown> {
  const pattern = typeof input.pattern === 'string' ? input.pattern : ''
  if (!pattern.trim()) throw new Error('Grep pattern is required')
  const searchRoot = typeof input.path === 'string' && input.path.trim() ? input.path : '.'
  const maxResults =
    typeof input.maxResults === 'number' && Number.isSafeInteger(input.maxResults)
      ? Math.max(1, Math.min(input.maxResults, 1000))
      : 1000
  const flags = input.caseSensitive === false ? 'i' : ''
  let matcher: RegExp
  try {
    matcher = new RegExp(pattern, flags)
  } catch {
    matcher = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
  }
  const outputMode =
    input.outputMode === 'files_with_matches' ||
    input.outputMode === 'files_without_matches' ||
    input.outputMode === 'count'
      ? input.outputMode
      : 'matches'

  return await withSftp(connectionId, async (sftp) => {
    const candidates = (await sftpGlob(sftp, searchRoot, '**/*')).filter(
      (entry) => entry.type === 'file'
    )
    const matches: SshGrepResult['matches'] = []
    const matchingFiles = new Set<string>()
    const maxBytes = 256 * 1024
    for (const candidate of candidates) {
      if (matches.length >= maxResults) break
      let text: string
      try {
        const bytes = await sftpReadFile(sftp, candidate.path)
        if (bytes.byteLength > maxBytes) continue
        text = bytes.toString('utf8')
      } catch {
        continue
      }
      const lines = text.replace(/\r\n/g, '\n').split('\n')
      const fileMatches = lines.flatMap((line, index) => {
        matcher.lastIndex = 0
        return matcher.test(line)
          ? [{ path: candidate.path, line: index + 1, text: line, kind: 'match' as const }]
          : []
      })
      if (fileMatches.length > 0) matchingFiles.add(candidate.path)
      if (outputMode === 'matches')
        matches.push(...fileMatches.slice(0, maxResults - matches.length))
    }
    const resultMatches =
      outputMode === 'matches'
        ? matches
        : [...matchingFiles].slice(0, maxResults).map((path) => ({ path }))
    if (outputMode === 'files_without_matches') {
      const matched = new Set(matchingFiles)
      resultMatches.splice(
        0,
        resultMatches.length,
        ...candidates
          .filter((candidate) => !matched.has(candidate.path))
          .slice(0, maxResults)
          .map((candidate) => ({ path: candidate.path }))
      )
    }
    if (outputMode === 'count') {
      resultMatches.splice(
        0,
        resultMatches.length,
        ...[...matchingFiles]
          .slice(0, maxResults)
          .map((path) => ({ path, count: matches.filter((match) => match.path === path).length }))
      )
    }
    return {
      kind: 'grep',
      matches: resultMatches,
      meta: {
        backend: 'ssh',
        engine: 'ssh2-sftp',
        searchRoot,
        pathStyle: 'absolute',
        truncated: candidates.length > maxResults || matches.length >= maxResults,
        timedOut: false,
        limitReason:
          candidates.length > maxResults || matches.length >= maxResults ? 'max_results' : null,
        pattern,
        hiddenIncluded: true,
        ignoredDefaultsApplied: false,
        outputMode
      }
    } satisfies SshGrepResult
  })
}

// ── Cleanup ──

export function closeAllSshSessions(): void {
  for (const session of sshSessions.values()) {
    try {
      session.userInitiatedDisconnect = true
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer)
      if (session.shell) session.shell.end()
      session.client.end()
    } catch {
      // ignore
    }
  }
  sshSessions.clear()
}
