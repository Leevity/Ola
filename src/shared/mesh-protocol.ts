/**
 * Versioned contracts for communication between independently released Ola Nodes.
 * Electron IPC contracts deliberately do not appear here.
 */
export const OLA_MESH_PROTOCOL_VERSION = 'v0alpha1'

export type MeshNodePlatform = 'android' | 'ios' | 'linux' | 'macos' | 'windows'
export type MeshCapabilityRisk = 'low' | 'medium' | 'high'

export type MeshCapability = {
  id: string
  risk: MeshCapabilityRisk
  version?: string
}

export type MeshNodeManifest = {
  protocolVersion: typeof OLA_MESH_PROTOCOL_VERSION
  deviceId: string
  nodeId: string
  platform: MeshNodePlatform
  runtime: string
  runtimeVersion: string
  publicKey: string
  capabilities: MeshCapability[]
}

export type MeshTaskEvent = {
  protocolVersion: typeof OLA_MESH_PROTOCOL_VERSION
  eventId: string
  sequence: number
  taskId: string
  sessionId: string
  type:
    | 'task.command'
    | 'task.started'
    | 'task.stdout'
    | 'task.stderr'
    | 'task.progress'
    | 'task.approval_required'
    | 'task.completed'
    | 'task.failed'
    | 'task.cancelled'
  timestamp: number
  payload: Record<string, unknown>
}

export type MeshCapabilityTicket = {
  protocolVersion: typeof OLA_MESH_PROTOCOL_VERSION
  issuer: 'ola-control-plane'
  ticketId: string
  accountId: string
  subjectNodeId: string
  targetNodeId: string
  sessionId: string
  capabilities: string[]
  nonce: string
  issuedAt: number
  expiresAt: number
}
