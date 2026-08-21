import type {
  ProviderCandidate,
  ProviderHealth,
  ProviderResolution
} from '../../shared/provider-health'

export type { ProviderCandidate, ProviderResolution } from '../../shared/provider-health'

export function resolveProviderFallback(args: {
  preferredProviderId?: string | null
  preferredModelId?: string | null
  candidates: ProviderCandidate[]
  health: ProviderHealth[]
  requireVision?: boolean
  requireComputerUse?: boolean
}): ProviderResolution {
  const healthMap = new Map(args.health.map((item) => [item.providerKey, item]))
  const eligible = args.candidates.filter((candidate) => {
    if (!candidate.enabled) return false
    if (args.requireVision && !candidate.supportsVision) return false
    if (args.requireComputerUse && !candidate.supportsComputerUse) return false
    return healthMap.get(candidate.providerId)?.status !== 'down'
  })
  const preferred = eligible.find(
    (candidate) =>
      candidate.providerId === args.preferredProviderId &&
      candidate.modelId === args.preferredModelId
  )
  if (preferred) {
    return {
      selected: preferred,
      fallbacks: eligible.filter((candidate) => candidate !== preferred),
      reason: 'preferred'
    }
  }
  const selected = eligible[0] ?? null
  return {
    selected,
    fallbacks: selected ? eligible.slice(1) : [],
    reason: selected
      ? eligible.length === args.candidates.length
        ? 'capability'
        : 'health'
      : 'none'
  }
}
