export const INPUT_DRAFT_SCHEMA_VERSION = 1 as const
export const INPUT_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const INPUT_DRAFT_MAX_COUNT = 100
export const INPUT_DRAFT_MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const INPUT_DRAFT_MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024
export const INPUT_DRAFT_MAX_TEXT_CHARS = 250_000

export type InputDraftScope = 'home' | 'project' | 'session' | 'subagent' | 'custom'

export interface InputDraftImage {
  id: string
  dataUrl: string
  mediaType: string
}

export interface InputDraftSelectedFile {
  id: string
  name: string
  originalPath: string
  sendPath: string
  previewPath: string
  isWorkspaceFile: boolean
}

export interface InputDraftContent {
  text: string
  images: InputDraftImage[]
  skill: string | null
  selectedFiles: InputDraftSelectedFile[]
}

export interface PersistedInputDraft extends InputDraftContent {
  version: typeof INPUT_DRAFT_SCHEMA_VERSION
  key: string
  scope: InputDraftScope
  updatedAt: number
}

export interface InputDraftWriteRequest {
  key: string
  draft: InputDraftContent
}

export interface InputDraftReadRequest {
  key: string
}

export interface InputDraftDeleteRequest {
  key: string
}

export interface InputDraftReadResult {
  success: boolean
  draft: PersistedInputDraft | null
  error?: string
}

export interface InputDraftMutationResult {
  success: boolean
  error?: string
}

function cleanKeyPart(value: string): string {
  return encodeURIComponent(value.trim())
}

export function getHomeInputDraftKey(identity = 'default'): string {
  return `v${INPUT_DRAFT_SCHEMA_VERSION}:home:${cleanKeyPart(identity)}`
}

export function getProjectInputDraftKey(projectId: string): string {
  return `v${INPUT_DRAFT_SCHEMA_VERSION}:project:${cleanKeyPart(projectId)}`
}

export function getSessionInputDraftKey(sessionId: string): string {
  return `v${INPUT_DRAFT_SCHEMA_VERSION}:session:${cleanKeyPart(sessionId)}`
}

export function getSubagentInputDraftKey(sessionId: string, agentId: string): string {
  return `v${INPUT_DRAFT_SCHEMA_VERSION}:subagent:${cleanKeyPart(sessionId)}:${cleanKeyPart(agentId)}`
}

export function getCustomInputDraftKey(namespace: string, identity: string): string {
  return `v${INPUT_DRAFT_SCHEMA_VERSION}:custom:${cleanKeyPart(namespace)}:${cleanKeyPart(identity)}`
}

export function parseInputDraftScope(key: string): InputDraftScope | null {
  const match = /^v1:(home|project|session|subagent|custom):/.exec(key)
  return (match?.[1] as InputDraftScope | undefined) ?? null
}

export function hasInputDraftContent(
  draft: Pick<InputDraftContent, 'text' | 'images' | 'skill' | 'selectedFiles'>
): boolean {
  return (
    draft.text.length > 0 ||
    draft.images.length > 0 ||
    draft.skill !== null ||
    draft.selectedFiles.length > 0
  )
}
