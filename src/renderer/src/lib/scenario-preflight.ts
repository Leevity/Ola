import type { ProviderHealth } from '../../../shared/provider-health'

export function isCurrentProjectPreflight(args: {
  requestId: number
  currentRequestId: number
  checkedWorkspaceId: string | null
  currentWorkspaceId: string | null
  checkedFolder: string
  currentFolder?: string
}): boolean {
  return (
    args.requestId === args.currentRequestId &&
    args.checkedWorkspaceId === args.currentWorkspaceId &&
    args.checkedFolder === args.currentFolder
  )
}

export function isCurrentSshPreflight(args: {
  requestId: number
  currentRequestId: number
  checkedWorkspaceId: string | null
  currentWorkspaceId: string | null
  checkedConnectionId: string
  currentConnectionId?: string | null
  scenarioOpen: boolean
}): boolean {
  return (
    args.scenarioOpen &&
    args.requestId === args.currentRequestId &&
    args.checkedWorkspaceId === args.currentWorkspaceId &&
    args.checkedConnectionId === args.currentConnectionId
  )
}

export function getScenarioProviderObservation(
  providerKey: string | null | undefined,
  providers: readonly ProviderHealth[]
): ProviderHealth | null {
  const normalizedKey = providerKey?.trim()
  if (!normalizedKey) return null
  const observation = providers.find((provider) => provider.providerKey === normalizedKey)
  if (!observation || (!observation.lastSucceededAt && !observation.lastFailedAt)) return null
  return observation
}
