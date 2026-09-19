import { useTranslation } from 'react-i18next'
import { useMemo } from 'react'
import { useProviderStore } from '@renderer/stores/provider-store'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'
import { workspaceModelProviders } from '@renderer/lib/workspace-models'

export function useWorkspaceProviders() {
  const { t } = useTranslation('layout')
  const local = useProviderStore((state) => state.providers)
  const workspace = useWorkspaceStore()
  return useMemo(
    () => [
      ...local.map((provider) => ({
        ...provider,
        name: `${t('sidebar.localModelSource')} · ${provider.name}`
      })),
      ...workspaceModelProviders(workspace)
    ],
    [local, workspace, t]
  )
}

export type WorkspaceModelRoute = 'main' | 'fast' | 'translation' | 'speech' | 'image'
export function workspaceModelRouteKey(workspaceId: string, route: WorkspaceModelRoute): string {
  return route === 'main' ? workspaceId : JSON.stringify([workspaceId, route])
}

export function useWorkspaceModelRoute(route: WorkspaceModelRoute) {
  const providers = useWorkspaceProviders()
  const local = useProviderStore()
  const workspace = useWorkspaceStore()
  const key = workspaceModelRouteKey(workspace.activeWorkspaceId, route)
  const selected = workspace.getModelSelection(key)
  const prefix = route === 'main' ? '' : route[0].toUpperCase() + route.slice(1)
  const fallback = local as unknown as Record<string, string | null>
  const providerId = selected?.providerId ?? fallback[`active${prefix}ProviderId`]
  const modelId = selected?.modelId ?? fallback[`active${prefix}ModelId`] ?? ''
  return {
    providerId,
    modelId,
    setProvider: (id: string) => {
      const provider = providers.find((item) => item.id === id)
      const category = route === 'image' || route === 'speech' ? route : 'chat'
      const model = provider?.models.find(
        (item) => item.enabled && (item.category ?? 'chat') === category
      )
      workspace.setModelSelection(key, { providerId: id, modelId: model?.id ?? '' })
    },
    setModel: (id: string) => {
      const current = useWorkspaceStore.getState().getModelSelection(key)
      const targetProvider = current?.providerId ?? providerId
      if (targetProvider)
        workspace.setModelSelection(key, { providerId: targetProvider, modelId: id })
    }
  }
}
