import { ModelBindingError, parseModelSource, type ModelSource } from './model-source'

/** Parses the public Cron binding before an unattended run is allowed to start. */
export function parseCronModelBinding(
  serialized: string | null | undefined,
  workspaceId: string | null | undefined
): ModelSource | null {
  if (!serialized) return null
  let source: ModelSource
  try {
    source = parseModelSource(JSON.parse(serialized))
  } catch {
    throw new ModelBindingError('INVALID_MODEL_SOURCE')
  }
  if (source.kind !== 'local' && source.workspaceId !== workspaceId)
    throw new ModelBindingError('WORKSPACE_MISMATCH')
  return source
}
