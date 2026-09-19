import type { AIModelConfig, AIProvider } from '@renderer/lib/api/types'
import type { Session, SessionModelSelectionMode } from '@renderer/stores/chat-store'
import type { MainModelSelectionMode } from '@renderer/stores/settings-store'
import type { TaskProfileConfig } from './task-profile'
import { modelSourceSelection, type ModelSource } from '../../../shared/runtime/model-source'

export type ResolvedSessionModelSource = 'plugin' | 'session' | 'profile' | 'global'

export interface ResolvedSessionModelSelection {
  mode: SessionModelSelectionMode
  effectiveMode: 'auto' | 'manual'
  source: ResolvedSessionModelSource
  providerId: string | null
  modelId: string | null
  provider: AIProvider | null
  model: AIModelConfig | null
  isAutoModeActive: boolean
  isSessionBound: boolean
}

export function normalizeSessionModelSelectionMode(
  value?: string | null,
  providerId?: string | null,
  modelId?: string | null
): SessionModelSelectionMode {
  if (providerId && modelId && value !== 'auto') return 'manual'
  if (value === 'inherit' || value === 'auto' || value === 'manual') return value
  return 'inherit'
}

export function resolveProviderDefaultModelId(
  providers: AIProvider[],
  providerId: string | null | undefined
): string | null {
  if (!providerId) return null
  const provider = providers.find((item) => item.id === providerId)
  if (!provider) return null
  if (provider.defaultModel) {
    const model = provider.models.find((item) => item.id === provider.defaultModel)
    if (model) return model.id
  }
  const enabledChatModels = provider.models.filter(
    (model) => model.enabled && (!model.category || model.category === 'chat')
  )
  if (enabledChatModels.length > 0) return enabledChatModels[0].id
  const enabledModels = provider.models.filter((model) => model.enabled)
  return enabledModels[0]?.id ?? provider.models[0]?.id ?? null
}

function resolveProviderAndModel(
  providers: AIProvider[],
  providerId: string | null,
  modelId: string | null
): Pick<ResolvedSessionModelSelection, 'provider' | 'model'> {
  const provider = providerId ? (providers.find((item) => item.id === providerId) ?? null) : null
  const model =
    provider && modelId ? (provider.models.find((item) => item.id === modelId) ?? null) : null
  return { provider, model }
}

export function resolveSessionModelSelection({
  session,
  providers,
  activeProviderId,
  activeModelId,
  globalMode,
  channelProviderId,
  channelModelId
}: {
  session?: Pick<
    Session,
    | 'pluginId'
    | 'providerId'
    | 'modelId'
    | 'modelSource'
    | 'modelSelectionMode'
    | 'profileConfigSnapshot'
  > | null
  providers: AIProvider[]
  activeProviderId: string | null
  activeModelId: string
  globalMode: MainModelSelectionMode
  channelProviderId?: string | null
  channelModelId?: string | null
}): ResolvedSessionModelSelection {
  const typedSelection = session?.modelSource
    ? modelSourceSelection(session.modelSource as ModelSource)
    : null
  const sessionProviderId = typedSelection?.providerId ?? session?.providerId
  const sessionModelId = typedSelection?.modelId ?? session?.modelId
  const mode = normalizeSessionModelSelectionMode(
    session?.modelSelectionMode,
    sessionProviderId,
    sessionModelId
  )

  const pluginProviderId = channelProviderId ?? sessionProviderId ?? null
  const pluginModelId =
    channelModelId ?? sessionModelId ?? resolveProviderDefaultModelId(providers, pluginProviderId)
  if (session?.pluginId && pluginProviderId && pluginModelId) {
    const { provider, model } = resolveProviderAndModel(providers, pluginProviderId, pluginModelId)
    return {
      mode: 'manual',
      effectiveMode: 'manual',
      source: 'plugin',
      providerId: pluginProviderId,
      modelId: pluginModelId,
      provider,
      model,
      isAutoModeActive: false,
      isSessionBound: true
    }
  }

  if (!session?.pluginId && mode === 'manual' && sessionProviderId && sessionModelId) {
    const { provider, model } = resolveProviderAndModel(
      providers,
      sessionProviderId,
      sessionModelId
    )
    return {
      mode,
      effectiveMode: 'manual',
      source: 'session',
      providerId: sessionProviderId,
      modelId: sessionModelId,
      provider,
      model,
      isAutoModeActive: false,
      isSessionBound: true
    }
  }

  if (!session?.pluginId && mode === 'auto') {
    const { provider, model } = resolveProviderAndModel(providers, activeProviderId, activeModelId)
    return {
      mode,
      effectiveMode: 'auto',
      source: 'session',
      providerId: activeProviderId,
      modelId: activeModelId || null,
      provider,
      model,
      isAutoModeActive: true,
      isSessionBound: false
    }
  }

  const profileConfig: TaskProfileConfig | undefined = session?.profileConfigSnapshot
  if (!session?.pluginId && profileConfig?.mainProviderId && profileConfig.mainModelId) {
    const { provider, model } = resolveProviderAndModel(
      providers,
      profileConfig.mainProviderId,
      profileConfig.mainModelId
    )
    return {
      mode: 'inherit',
      effectiveMode: 'manual',
      source: 'profile',
      providerId: profileConfig.mainProviderId,
      modelId: profileConfig.mainModelId,
      provider,
      model,
      isAutoModeActive: false,
      isSessionBound: false
    }
  }

  const inheritedAuto = globalMode === 'auto'
  const { provider, model } = resolveProviderAndModel(providers, activeProviderId, activeModelId)
  return {
    mode: 'inherit',
    effectiveMode: inheritedAuto ? 'auto' : 'manual',
    source: 'global',
    providerId: activeProviderId,
    modelId: activeModelId || null,
    provider,
    model,
    isAutoModeActive: inheritedAuto,
    isSessionBound: false
  }
}
