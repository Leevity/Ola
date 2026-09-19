import type { AIProvider, ProviderConfig } from './api/types'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'
import { isOlaManagedProviderId, workspaceProviderId } from './workspace-context'

// A view of the resource directory, never inserted into the local Provider Store.
export function workspaceModelProviders(state = useWorkspaceStore.getState()): AIProvider[] {
  const workspace = state.getActiveWorkspace()
  if (workspace.kind === 'local-personal') return []
  return [
    {
      id: workspaceProviderId(workspace.id),
      name: `${workspace.kind === 'ola-team' ? 'Ola Team' : 'Ola'} · ${workspace.name}`,
      type: 'openai-chat',
      apiKey: '',
      baseUrl: 'https://ola.invalid',
      enabled: true,
      requiresApiKey: false,
      createdAt: 0,
      models: (state.resourcesByWorkspace[workspace.id] ?? []).map((resource) => ({
        id: resource.id,
        name: resource.displayName ?? resource.model,
        enabled: resource.enabled,
        category: resource?.category,
        supportsVision: resource.supportsVision,
        supportsFunctionCall: resource.supportsFunctionCall
      }))
    }
  ]
}

export function managedProviderConfig(
  providerId: string,
  resourceId: string
): ProviderConfig | null {
  if (!isOlaManagedProviderId(providerId)) return null
  const state = useWorkspaceStore.getState()
  const workspaceId = providerId.slice('ola-managed:'.length)
  const resource = state.resourcesByWorkspace[workspaceId]?.find((item) => item.id === resourceId)
  // Never silently replace a revoked model with another provider.
  const available = workspaceId === state.activeWorkspaceId && resource?.enabled === true
  return {
    type: resource?.category === 'image' ? 'openai-images' : 'openai-chat',
    providerId,
    model: resourceId,
    category: resource?.category,
    apiKey: '',
    requiresApiKey: false,
    baseUrl: available
      ? `https://ola.invalid/workspaces/${encodeURIComponent(workspaceId)}/resources/${encodeURIComponent(resourceId)}/v1`
      : 'https://ola.invalid/unavailable/v1'
  }
}
