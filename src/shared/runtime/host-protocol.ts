import type { AgentMessage, ModelDelta, ModelTool, ModelToolCall, ModelToolResult } from './model'
import type { PendingRuntimeInteraction, RunRecord, RunSpec } from './contracts'

/**
 * Capabilities the isolated runtime does not own. Main serves these because it
 * holds the credentials, the desktop DAOs, the hook service and the approval
 * policy; the child never receives a provider key or a Main handle.
 */
export const HOST_CALLBACK_METHODS = [
  'authorize',
  'workspace.authority',
  'tool.catalog',
  'tool.execute',
  'tool.abort',
  'tool.release',
  'provider.stream',
  'provider.stream.cancel'
] as const
export type HostCallbackMethod = (typeof HOST_CALLBACK_METHODS)[number]

/**
 * The mirror direction. A Main-side tool emits into a run whose journal lives in
 * the child, asks that run's scheduler for an approval, or submits a nested run.
 * Only the negotiated host connection may call these.
 */
export const HOST_RUNTIME_METHODS = [
  'host.run.record',
  'host.run.interaction',
  'host.run.submit-nested',
  'host.workspace.revoke',
  'host.artifact.record'
] as const
export type HostRuntimeMethod = (typeof HOST_RUNTIME_METHODS)[number]

export function isHostRuntimeMethod(value: string): value is HostRuntimeMethod {
  return (HOST_RUNTIME_METHODS as readonly string[]).includes(value)
}

export interface HostAuthorizeParams {
  run: RunSpec
}
export interface HostWorkspaceAuthorityResult {
  workspaceIds: string[]
}
export interface HostToolCatalogParams {
  run: RunSpec
}
export interface HostToolCatalogResult {
  tools: ModelTool[]
}
export interface HostToolExecuteParams {
  runId: string
  calls: ModelToolCall[]
}
export interface HostToolExecuteResult {
  results: ModelToolResult[]
}
export interface HostRunKeyParams {
  runId: string
}

/**
 * `reset` carries the whole conversation once; later turns carry only what the
 * agent appended. Resending the full history every turn would put a long run
 * over the frame bound for no reason.
 */
export interface HostProviderStreamParams {
  streamId: string
  runId: string
  messages: AgentMessage[]
  tools: ModelTool[]
  reset: boolean
  run?: RunSpec
}
export interface HostStreamParams {
  streamId: string
}

/** A host-stream notification. `end` closes the stream; `error` closes it failed. */
export interface HostStreamFrame {
  streamId: string
  delta?: ModelDelta
  end?: boolean
  error?: string
}

export interface HostRunRecordParams {
  workspaceId: string
  runId: string
  type: string
  data: unknown
}
export interface HostRunInteractionParams {
  workspaceId: string
  runId: string
  interaction: Omit<PendingRuntimeInteraction, 'runId' | 'workspaceId' | 'createdAt'>
}
export interface HostRunNestedParams {
  workspaceId: string
  spec: unknown
}
export type HostRunSubmitNestedResult = RunRecord
export interface HostWorkspaceRevokeParams {
  workspaceIds: string[]
}
export interface HostArtifactRecordParams {
  spec: RunSpec
  artifact: { path: string; mediaType: string }
}
