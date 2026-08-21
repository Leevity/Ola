export type ProviderHealthStatus = 'healthy' | 'degraded' | 'down'

export type ProviderFailureKind =
  | 'timeout'
  | 'network'
  | 'rate_limit'
  | 'server'
  | 'authentication'
  | 'invalid_request'
  | 'unknown'

export interface ProviderHealth {
  providerKey: string
  status: ProviderHealthStatus
  consecutiveFailures: number
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  averageLatencyMs: number | null
  lastFailureKind?: ProviderFailureKind
  lastError?: string
  lastStatusCode?: number
  lastStartedAt?: number
  lastSucceededAt?: number
  lastFailedAt?: number
  updatedAt: number
}

export interface ProviderHealthSnapshot {
  providers: ProviderHealth[]
  generatedAt: number
}

export interface ProviderHealthFailure {
  kind: ProviderFailureKind
  message: string
  statusCode?: number
  retryable: boolean
}

export interface ProviderCandidate {
  providerId: string
  modelId: string
  enabled: boolean
  supportsVision?: boolean
  supportsComputerUse?: boolean
}

export interface ProviderResolution {
  selected: ProviderCandidate | null
  fallbacks: ProviderCandidate[]
  reason: 'preferred' | 'health' | 'capability' | 'none'
}
