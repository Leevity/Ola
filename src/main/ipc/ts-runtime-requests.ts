import { RuntimeError } from '../../shared/runtime/contracts'

export interface RuntimeRunLocator {
  workspaceId: string
  runId: string
}

export interface RuntimeRunSnapshotLocator extends RuntimeRunLocator {
  afterSeq: number
}

export interface RuntimeInteractionRequest extends RuntimeRunLocator {
  interactionId: string
  response: unknown
}

function asRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new RuntimeError('INVALID_REQUEST')
  return input as Record<string, unknown>
}

function exactRecord(input: unknown, fields: readonly string[]): Record<string, unknown> {
  const value = asRecord(input)
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw new RuntimeError('INVALID_REQUEST')
  return value
}

export function parseRuntimeIdentifier(input: unknown): string {
  if (
    typeof input !== 'string' ||
    !input.trim() ||
    input.length > 256 ||
    Array.from(input).some((character) => character.charCodeAt(0) < 32)
  )
    throw new RuntimeError('INVALID_REQUEST')
  return input.trim()
}

export function parseRuntimeWorkspaceRequest(input: unknown): { workspaceId: string } {
  const value = exactRecord(input, ['workspaceId'])
  return { workspaceId: parseRuntimeIdentifier(value.workspaceId) }
}

export function parseRuntimeWorkspaceSwitchRequest(input: unknown): {
  fromWorkspaceId: string
  workspaceId: string
} {
  const value = exactRecord(input, ['fromWorkspaceId', 'workspaceId'])
  return {
    fromWorkspaceId: parseRuntimeIdentifier(value.fromWorkspaceId),
    workspaceId: parseRuntimeIdentifier(value.workspaceId)
  }
}

export function parseRuntimeRunLocator(input: unknown): RuntimeRunLocator {
  const value = exactRecord(input, ['workspaceId', 'runId'])
  return {
    workspaceId: parseRuntimeIdentifier(value.workspaceId),
    runId: parseRuntimeIdentifier(value.runId)
  }
}

export function parseRuntimeRunSnapshotLocator(input: unknown): RuntimeRunSnapshotLocator {
  const value = exactRecord(input, ['workspaceId', 'runId', 'afterSeq'])
  if (
    typeof value.afterSeq !== 'number' ||
    !Number.isSafeInteger(value.afterSeq) ||
    value.afterSeq < 0
  )
    throw new RuntimeError('INVALID_REQUEST')
  return {
    workspaceId: parseRuntimeIdentifier(value.workspaceId),
    runId: parseRuntimeIdentifier(value.runId),
    afterSeq: value.afterSeq
  }
}

export function parseRuntimeInteractionRequest(input: unknown): RuntimeInteractionRequest {
  const value = exactRecord(input, ['workspaceId', 'runId', 'interactionId', 'response'])
  if (value.response === undefined) throw new RuntimeError('INVALID_REQUEST')
  let encoded: string
  try {
    encoded = JSON.stringify(value.response)
  } catch {
    throw new RuntimeError('INVALID_REQUEST')
  }
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > 256 * 1024)
    throw new RuntimeError('INVALID_REQUEST')
  return {
    workspaceId: parseRuntimeIdentifier(value.workspaceId),
    runId: parseRuntimeIdentifier(value.runId),
    interactionId: parseRuntimeIdentifier(value.interactionId),
    response: value.response
  }
}
