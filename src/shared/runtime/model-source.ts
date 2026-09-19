/** Account resources are identifiers, never credentials or ordinary local providers. */
export type ModelSource =
  | { kind: 'local'; providerId: string; modelId: string }
  | { kind: 'ola-personal' | 'ola-team'; workspaceId: string; resourceId: string }

export type ModelPurpose = 'main' | 'fast' | 'translation' | 'image' | 'speech'
export type WorkspaceKind = 'local-personal' | 'ola-personal' | 'ola-team'
export const LOCAL_PERSONAL_WORKSPACE_ID = 'local-personal'

export class ModelBindingError extends Error {
  constructor(
    readonly code:
      | 'MODEL_NOT_SELECTED'
      | 'INVALID_MODEL_SOURCE'
      | 'MODEL_UNAVAILABLE'
      | 'WORKSPACE_MISMATCH'
      | 'ACCOUNT_UNAVAILABLE'
  ) {
    super(code)
    this.name = 'ModelBindingError'
  }
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32)
  )
}

export function parseModelSource(input: unknown): ModelSource {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ModelBindingError('INVALID_MODEL_SOURCE')
  const value = input as Record<string, unknown>
  const keys = Object.keys(value).sort().join(',')
  if (
    value.kind === 'local' &&
    keys === 'kind,modelId,providerId' &&
    identifier(value.providerId) &&
    identifier(value.modelId) &&
    !value.providerId.startsWith('ola-managed:') &&
    value.providerId !== 'ola-account-gateway'
  ) {
    return { kind: 'local', providerId: value.providerId, modelId: value.modelId }
  }
  if (
    (value.kind === 'ola-personal' || value.kind === 'ola-team') &&
    keys === 'kind,resourceId,workspaceId' &&
    identifier(value.workspaceId) &&
    value.workspaceId !== LOCAL_PERSONAL_WORKSPACE_ID &&
    identifier(value.resourceId)
  ) {
    return { kind: value.kind, workspaceId: value.workspaceId, resourceId: value.resourceId }
  }
  throw new ModelBindingError('INVALID_MODEL_SOURCE')
}

/** Unknown managed workspace kinds must not be guessed from a cached provider id. */
export function legacyModelSource(
  providerId: string,
  modelId: string,
  workspaceKind?: WorkspaceKind
): ModelSource {
  if (!providerId.startsWith('ola-managed:'))
    return parseModelSource({ kind: 'local', providerId, modelId })
  if (workspaceKind !== 'ola-personal' && workspaceKind !== 'ola-team')
    throw new ModelBindingError('WORKSPACE_MISMATCH')
  return parseModelSource({
    kind: workspaceKind,
    workspaceId: providerId.slice(12),
    resourceId: modelId
  })
}

export function modelSourceSelection(source: ModelSource): { providerId: string; modelId: string } {
  return source.kind === 'local'
    ? { providerId: source.providerId, modelId: source.modelId }
    : { providerId: `ola-managed:${source.workspaceId}`, modelId: source.resourceId }
}

export interface ModelBindingContext {
  workspaceId: string
  run?: ModelSource | null
  session?: ModelSource | null
  workspaceDefault?: ModelSource | null
}

/** Selection and authorization are deliberately separate; an unavailable binding never falls through. */
export function resolveModelBinding(context: ModelBindingContext): ModelSource {
  const source = context.run ?? context.session ?? context.workspaceDefault
  if (!source) throw new ModelBindingError('MODEL_NOT_SELECTED')
  const parsed = parseModelSource(source)
  if (parsed.kind !== 'local' && parsed.workspaceId !== context.workspaceId)
    throw new ModelBindingError('WORKSPACE_MISMATCH')
  return Object.freeze(parsed)
}
