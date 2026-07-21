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
