export const PROVIDER_STORE_KEY = 'ola-providers'
export const PROVIDER_CONTRACT_VERSION = 1

export interface SharedProviderModel {
  id: string
  name?: string
  type?: string
  [key: string]: unknown
}

export interface SharedProviderRecord {
  id: string
  name: string
  type: string
  apiKey?: string
  baseUrl: string
  enabled: boolean
  models: SharedProviderModel[]
  builtinId?: string
  authMode?: string
  [key: string]: unknown
}

export interface PersistedProviderState {
  providers: SharedProviderRecord[]
  activeProviderId?: string | null
  activeModelId?: string
  activeFastProviderId?: string | null
  activeFastModelId?: string
  [key: string]: unknown
}

export interface ProviderMirrorSnapshot {
  version: typeof PROVIDER_CONTRACT_VERSION
  revision: string
  providerCount: number
  providers: Array<{
    id: string
    name: string
    type: string
    baseUrl: string
    enabled: boolean
    modelIds: string[]
    builtinId?: string
    authMode?: string
    hasSecret: boolean
  }>
  activeProviderId?: string | null
  activeModelId?: string
}
