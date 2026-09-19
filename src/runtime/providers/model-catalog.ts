import {
  ModelBindingError,
  resolveModelBinding,
  type ModelBindingContext,
  type ModelSource
} from '../../shared/runtime/model-source'

export interface ModelCatalog {
  local: ReadonlyArray<{
    id: string
    enabled: boolean
    models: ReadonlyArray<{ id: string; enabled: boolean }>
  }>
  account: {
    authenticated: boolean
    workspaces: ReadonlyArray<{
      id: string
      kind: 'ola-personal' | 'ola-team'
      resources: ReadonlyArray<{ id: string; enabled: boolean }>
    }>
  }
}

export function resolveAvailableModel(
  context: ModelBindingContext,
  catalog: ModelCatalog
): ModelSource {
  const source = resolveModelBinding(context)
  if (source.kind === 'local') {
    const provider = catalog.local.find((item) => item.id === source.providerId && item.enabled)
    if (!provider?.models.some((model) => model.id === source.modelId && model.enabled))
      throw new ModelBindingError('MODEL_UNAVAILABLE')
  } else {
    if (!catalog.account.authenticated) throw new ModelBindingError('ACCOUNT_UNAVAILABLE')
    const workspace = catalog.account.workspaces.find(
      (item) => item.id === source.workspaceId && item.kind === source.kind
    )
    if (!workspace?.resources.some((item) => item.id === source.resourceId && item.enabled))
      throw new ModelBindingError('MODEL_UNAVAILABLE')
  }
  return source
}
