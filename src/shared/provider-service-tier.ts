export interface ProviderServiceTierResolutionInput {
  fastModeEnabled: boolean
  providerBuiltinId?: string | null
  modelServiceTier?: string | null
}

/** Resolve the optional provider tier consistently across foreground and background runs. */
export function resolveProviderServiceTier({
  fastModeEnabled,
  providerBuiltinId,
  modelServiceTier
}: ProviderServiceTierResolutionInput): string | undefined {
  if (!modelServiceTier) return undefined
  if (providerBuiltinId === 'codex-oauth') return modelServiceTier
  return fastModeEnabled ? modelServiceTier : undefined
}
