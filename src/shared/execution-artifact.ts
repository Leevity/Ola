import type { RunStatus } from './runtime/contracts'

/** Durable, confirmed result emitted by a runtime tool and scoped to its run. */
export interface ExecutionArtifactBase {
  id: string
  workspaceId: string
  projectId: string | null
  sessionId: string
  runId: string
  seq: number
  toolCallId: string
  kind: 'file' | 'link'
  title: string
  createdAt: number
  runStatus: RunStatus
}

export interface ExecutionFileArtifact extends ExecutionArtifactBase {
  kind: 'file'
  transport: 'local' | 'ssh'
  connectionId?: string
  mediaType?: string
  path: string
  operation: 'create' | 'modify'
  exists: boolean
}

export interface ExecutionLinkArtifact extends ExecutionArtifactBase {
  kind: 'link'
  url: string
}

export type ExecutionArtifact = ExecutionFileArtifact | ExecutionLinkArtifact

export interface ExecutionArtifactPage {
  artifacts: ExecutionArtifact[]
  nextOffset: number | null
}

export type ExecutionArtifactCategory =
  | 'all'
  | 'link'
  | 'image'
  | 'media'
  | 'document'
  | 'data'
  | 'other'
