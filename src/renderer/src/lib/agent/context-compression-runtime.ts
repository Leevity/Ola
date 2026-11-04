import type { AIModelConfig, ProviderConfig, UnifiedMessage } from '../api/types'
import { useProviderStore } from '../../stores/provider-store'
import { useSettingsStore } from '../../stores/settings-store'
import {
  compressMessages,
  resolveCompressionContextLength,
  resolveCompressionReservedOutputBudget,
  resolveCompressionThreshold,
  type CompressionConfig
} from './context-compression'

/** Compresses the loop's messages using the configured compression model. */
export type CompressFn = (
  messages: UnifiedMessage[],
  options?: { preserveCount?: number }
) => Promise<UnifiedMessage[]>

function findModelConfig(providerConfig: ProviderConfig): AIModelConfig | null {
  const { providers } = useProviderStore.getState()

  if (providerConfig.providerId) {
    const provider = providers.find((item) => item.id === providerConfig.providerId)
    const model = provider?.models.find((item) => item.id === providerConfig.model)
    if (model) return model
  }

  for (const provider of providers) {
    const model = provider.models.find((item) => item.id === providerConfig.model)
    if (model) return model
  }

  return null
}

export function buildRuntimeCompressionConfig(
  providerConfig: ProviderConfig
): CompressionConfig | null {
  const settings = useSettingsStore.getState()
  if (!settings.contextCompressionEnabled) return null

  const modelConfig = findModelConfig(providerConfig)
  if (!modelConfig?.contextLength) return null

  const contextLength = resolveCompressionContextLength(modelConfig)
  if (!contextLength || contextLength <= 0) return null

  return {
    enabled: true,
    contextLength,
    threshold: resolveCompressionThreshold(settings.contextCompressionThreshold),
    preCompressThreshold: 0.65,
    reservedOutputBudget: resolveCompressionReservedOutputBudget(modelConfig)
  }
}

export function buildRuntimeCompression(
  providerConfig: ProviderConfig,
  signal: AbortSignal
): { config: CompressionConfig; compressFn: CompressFn } | undefined {
  const config = buildRuntimeCompressionConfig(providerConfig)
  if (!config) return undefined

  return {
    config,
    compressFn: async (messages: UnifiedMessage[], options) => {
      const { messages: compressed } = await compressMessages(
        messages,
        useSettingsStore.getState().contextCompressionModel
          ? (useProviderStore
              .getState()
              .getProviderConfigById(
                useSettingsStore.getState().contextCompressionModel!.providerId,
                useSettingsStore.getState().contextCompressionModel!.modelId
              ) ?? providerConfig)
          : providerConfig,
        signal,
        options?.preserveCount,
        undefined,
        undefined,
        'auto'
      )
      return compressed
    }
  }
}
