import { createHash } from 'node:crypto'
import {
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_STORE_KEY,
  type PersistedProviderState,
  type ProviderMirrorSnapshot,
  type SharedProviderRecord
} from '../../shared/provider-contract'
import { decodePersistedStoreState } from '../ipc/settings-handlers'

let mirroredState: PersistedProviderState = { providers: [] }
let revision = revisionOf(mirroredState)

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)])
  )
}

function revisionOf(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')
}

function isProvider(value: unknown): value is SharedProviderRecord {
  if (!value || typeof value !== 'object') return false
  const provider = value as Partial<SharedProviderRecord>
  return (
    typeof provider.id === 'string' &&
    typeof provider.name === 'string' &&
    typeof provider.type === 'string' &&
    typeof provider.baseUrl === 'string' &&
    typeof provider.enabled === 'boolean' &&
    Array.isArray(provider.models)
  )
}

export function updateProviderMainMirror(key: string, raw: unknown): void {
  if (key !== PROVIDER_STORE_KEY) return
  const decoded = decodePersistedStoreState<PersistedProviderState>(raw)
  const providers = Array.isArray(decoded?.providers) ? decoded.providers.filter(isProvider) : []
  mirroredState = { ...(decoded ?? {}), providers }
  revision = revisionOf(mirroredState)
}

export function hydrateProviderMainMirror(config: Record<string, unknown>): void {
  updateProviderMainMirror(PROVIDER_STORE_KEY, config[PROVIDER_STORE_KEY])
}

export function getProviderMainMirrorSnapshot(): ProviderMirrorSnapshot {
  return {
    version: PROVIDER_CONTRACT_VERSION,
    revision,
    providerCount: mirroredState.providers.length,
    providers: mirroredState.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      modelIds: provider.models
        .map((model) => (model && typeof model.id === 'string' ? model.id : ''))
        .filter(Boolean),
      ...(provider.builtinId ? { builtinId: provider.builtinId } : {}),
      ...(provider.authMode ? { authMode: provider.authMode } : {}),
      hasSecret: typeof provider.apiKey === 'string' && provider.apiKey.length > 0
    })),
    activeProviderId: mirroredState.activeProviderId,
    activeModelId: mirroredState.activeModelId
  }
}
