import type { ProviderConfig } from '@renderer/lib/api/types'
import type { ModelSource } from '../../../../shared/runtime/model-source'
import { explicitTsRuntimeModelSource } from './ts-runtime-text-eligibility'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'

export function resolveTsRuntimeModelBinding(provider: ProviderConfig): {
  workspaceId: string
  modelSource: ModelSource
} | null {
  const store = useWorkspaceStore.getState()
  const managedWorkspaceId = provider.providerId?.startsWith('ola-managed:')
    ? provider.providerId.slice('ola-managed:'.length)
    : undefined
  const workspace = managedWorkspaceId
    ? store.getWorkspaces().find((item) => item.id === managedWorkspaceId)
    : store.getActiveWorkspace()
  if (!workspace) return null
  const modelSource = explicitTsRuntimeModelSource({
    providerId: provider.providerId,
    modelId: provider.model,
    managedWorkspaceKind:
      workspace.kind === 'ola-personal' || workspace.kind === 'ola-team'
        ? workspace.kind
        : undefined
  })
  return modelSource ? { workspaceId: workspace.id, modelSource } : null
}
