export type RemoteConnectionKind = 'ssh' | 'rdp' | 'vnc' | 'ola-device'

export type RemoteConnectionBase = {
  id: string
  kind: RemoteConnectionKind
  groupId: string | null
  name: string
  host?: string | null
  port?: number | null
  username?: string | null
  credentialRef?: string | null
  tags?: string[]
  lastConnectedAt: number | null
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export type RdpConnectionConfig = {
  domain?: string | null
  colorDepth: 16 | 24 | 32
  audio: boolean
  clipboard: boolean
  resize: 'fixed' | 'stretch' | 'dynamic'
  width?: number | null
  height?: number | null
  launchMode: 'external' | 'embedded'
}

export type VncConnectionConfig = {
  display?: number | null
  viewOnly: boolean
  encoding?: 'tight' | 'zrle' | 'raw' | null
  quality?: number | null
  shared?: boolean
  launchMode: 'novnc' | 'external'
}

export type OlaDeviceConnectionConfig = {
  deviceId: string
  accountId?: string | null
  deviceName: string
  platform: 'macos' | 'windows' | 'linux'
  trusted: boolean
  lastSeenAt?: number | null
}

export type RemoteConnection = RemoteConnectionBase & {
  rdp?: RdpConnectionConfig | null
  vnc?: VncConnectionConfig | null
  olaDevice?: OlaDeviceConnectionConfig | null
}

export type RemoteConnectionCreateInput = {
  kind: RemoteConnectionKind
  groupId?: string | null
  name: string
  host?: string | null
  port?: number | null
  username?: string | null
  credentialRef?: string | null
  tags?: string[]
  rdp?: Partial<RdpConnectionConfig> | null
  vnc?: Partial<VncConnectionConfig> | null
  olaDevice?: OlaDeviceConnectionConfig | null
}

export type RemoteConnectionCreateRequest = RemoteConnectionCreateInput & {
  /** Sent once to the main process and stored in SecretVault; never written to connection JSON. */
  password?: string | null
}

export type RemoteConnectionUpdateInput = {
  id: string
  patch: Partial<
    RemoteConnectionCreateInput & { sortOrder: number; lastConnectedAt: number | null }
  >
}

export type RemoteConnectionUpdateRequest = RemoteConnectionUpdateInput & {
  /** Replaces the stored secret when provided. An empty or omitted value preserves it. */
  password?: string | null
}

export type RemoteConnectionListResult = {
  connections: RemoteConnection[]
}

export type RemoteSessionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export type RemoteSession = {
  id: string
  kind: 'rdp' | 'vnc' | 'ola-device'
  connectionId?: string | null
  status: RemoteSessionStatus
  error?: string | null
  viewerUrl?: string | null
  viewerType?: 'rdp' | 'vnc' | null
  viewerDestination?: string | null
  credentialAvailable?: boolean
  createdAt: number
  updatedAt: number
}

export type RemoteViewerCredential = {
  username: string
  password: string
  domain?: string | null
}

export type RemoteConnectInput = {
  connectionId: string
}

/**
 * Returned only from the connection-creation call. The lease is purpose-bound to one
 * embedded viewer authentication, the creating WebContents, and a short expiration.
 * It is never part of RemoteSession or persisted renderer state.
 */
export type RemoteConnectResult = {
  session: RemoteSession
  credentialLease: string | null
}

export type RemoteCredentialClaimRequest = {
  sessionId: string
  lease: string
}

export type RemoteConnectionTestResult = {
  success: boolean
  host: string
  port: number
  latencyMs: number | null
  category: 'reachable' | 'timeout' | 'dns' | 'refused' | 'network' | 'invalid'
  message: string
}

export type RemoteInputEvent =
  | { type: 'pointerMove'; x: number; y: number }
  | {
      type: 'pointerButton'
      x: number
      y: number
      button: 'left' | 'middle' | 'right'
      action: 'down' | 'up'
    }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; key: string; action: 'down' | 'up'; modifiers?: string[] }
  | { type: 'text'; text: string }

export type RemoteInputEnvelope = {
  sessionId: string
  event: RemoteInputEvent
}

/**
 * One tool step of a run the controlled machine is executing. Arguments and
 * output are deliberately digested here: a controller needs to see progress,
 * not to receive the machine's full tool payloads over a peer channel.
 */
export type RemoteTaskStep = {
  id: string
  name: string
  status: 'running' | 'completed' | 'failed'
  startedAt: number
  finishedAt?: number
  /** Single-line argument digest, already truncated by the producer. */
  summary?: string
  /** Truncated result text, present once the step settles. */
  output?: string
}

export type RemoteTaskStatus =
  | 'running'
  | 'waiting_interaction'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/**
 * The controlled machine's view of the run it is executing, pushed to whoever
 * is controlling it. This is a projection, not a log: a controller joining
 * late must still be able to tell what is happening now.
 */
export type RemoteTaskSnapshot = {
  runId: string
  /** Chat session the run belongs to; successive turns share one. */
  sessionId?: string | null
  status: RemoteTaskStatus
  /** First line of the prompt that started the run. */
  title: string
  /**
   * Directory the run is working in. This is the one piece of machine context
   * an operator needs to make sense of the steps: "LS" means nothing without
   * knowing which folder it listed.
   */
  workingDirectory?: string
  /** When the run started locally, so a controller can show elapsed time. */
  startedAt: number
  /** Accumulated assistant text, tail-truncated by the producer. */
  text: string
  steps: RemoteTaskStep[]
  seq: number
  updatedAt: number
  /** True once the run reached a terminal status; no further updates follow. */
  done: boolean
}

/**
 * Durable answer to "may this machine be controlled remotely". It lives on the
 * control plane so it survives restarts and is visible to the console; the
 * short-lived signalling lease only decides whether a session may start now.
 */
export type RemoteAccessMode = 'none' | 'attended' | 'unattended'

/** Unknown values collapse to `none` so a bad payload can never widen access. */
export function normalizeRemoteAccessMode(value: unknown): RemoteAccessMode {
  return value === 'attended' || value === 'unattended' ? value : 'none'
}

/**
 * Derives the signalling endpoint from the account API base URL, so one server
 * address is all a user ever configures. Development runs the API and the
 * signalling hub on adjacent ports (:7300/:7301); in production both sit behind
 * the same host, so a standard port maps to itself and the reverse proxy
 * forwards `/ws/signaling`.
 */
export function signalingUrlForApi(apiBaseUrl: string | null | undefined): string {
  try {
    const url = new URL(apiBaseUrl ?? '')
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    const standard = port === 80 || port === 443
    const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${url.hostname}${standard ? '' : `:${port + 1}`}/ws/signaling`
  } catch {
    return ''
  }
}

/** Mode returned by GET/PUT /api/devices/{id}/remote-access. */
export type RemoteAccessState = {
  deviceId: string
  deviceName: string
  remoteAccessMode: RemoteAccessMode
  /** True only for unattended: remote tool approvals run without a human. */
  autoApprove: boolean
  online: boolean
  /** Whether the short-lived signalling lease is currently held. */
  leaseActive: boolean
  updatedAt?: string | null
  updatedBy?: string
}

/** What the main process publishes to every window about remote access. */
export type RemoteAccessSnapshot = {
  mode: RemoteAccessMode
  /** Session id of the live inbound control session, if any. */
  sessionId: string | null
  /** Automatic approvals already granted in the current 12h window. */
  autoApprovalsUsed: number
  autoApprovalsLimit: number
}

/**
 * An inbound Mesh task asking this desktop to run an Agent turn.
 *
 * The main process is the only writer: it records a task after verifying the
 * signed envelope, so a renderer can decide on a task it was shown but can
 * never invent one. `text` is the peer's prompt, already bounded to 12 KiB by
 * the verifier.
 */
export type RemoteMeshTask = {
  taskId: string
  sessionId: string
  sourceNodeId: string
  text: string
  receivedAt: number
  status: 'pending' | 'admitted' | 'running' | 'completed' | 'failed' | 'rejected' | 'expired'
}

export type RemoteTaskRejection =
  | 'unknown-task'
  | 'already-decided'
  | 'user-rejected'
  | 'access-disabled'
  | 'session-busy'
  | 'confirmation-required'
  | 'quota-exhausted'

export type RemoteTaskDecision =
  | { accepted: true; taskId: string; sessionId: string; automatic: boolean }
  | { accepted: false; taskId: string; reason: RemoteTaskRejection }
