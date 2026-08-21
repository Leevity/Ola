import type {
  ProviderHealth,
  ProviderHealthFailure,
  ProviderHealthSnapshot,
  ProviderFailureKind
} from '../../shared/provider-health'

const MAX_ERROR_LENGTH = 500
const DEGRADED_FAILURE_THRESHOLD = 1
const DOWN_FAILURE_THRESHOLD = 3

type MutableHealth = ProviderHealth & { latencyTotalMs: number }

function normalizeKey(value: string | undefined): string | null {
  const key = value?.trim()
  return key ? key.slice(0, 160) : null
}

function initialHealth(providerKey: string): MutableHealth {
  return {
    providerKey,
    status: 'healthy',
    consecutiveFailures: 0,
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    averageLatencyMs: null,
    latencyTotalMs: 0,
    updatedAt: Date.now()
  }
}

function sanitizeError(message: string): string {
  return message.replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted]').slice(0, MAX_ERROR_LENGTH)
}

function getOrCreate(providerKey: string): MutableHealth {
  const existing = registry.get(providerKey)
  if (existing) return existing
  const next = initialHealth(providerKey)
  registry.set(providerKey, next)
  return next
}

function updateStatus(record: MutableHealth): void {
  if (record.consecutiveFailures >= DOWN_FAILURE_THRESHOLD) {
    record.status = 'down'
  } else if (record.consecutiveFailures >= DEGRADED_FAILURE_THRESHOLD) {
    record.status = 'degraded'
  } else {
    record.status = 'healthy'
  }
}

const registry = new Map<string, MutableHealth>()

export function recordProviderRequestStarted(providerId?: string, builtinId?: string): void {
  const providerKey = normalizeKey(providerId || builtinId)
  if (!providerKey) return
  const record = getOrCreate(providerKey)
  record.totalRequests += 1
  record.lastStartedAt = Date.now()
  record.updatedAt = Date.now()
}

export function recordProviderRequestSucceeded(
  providerId: string | undefined,
  builtinId: string | undefined,
  latencyMs: number
): void {
  const providerKey = normalizeKey(providerId || builtinId)
  if (!providerKey) return
  const record = getOrCreate(providerKey)
  const safeLatency = Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : 0
  record.successfulRequests += 1
  record.consecutiveFailures = 0
  record.latencyTotalMs += safeLatency
  record.averageLatencyMs = Math.round(record.latencyTotalMs / record.successfulRequests)
  record.lastSucceededAt = Date.now()
  record.lastFailureKind = undefined
  record.lastError = undefined
  record.lastStatusCode = undefined
  updateStatus(record)
  record.updatedAt = Date.now()
}

export function recordProviderRequestFailed(
  providerId: string | undefined,
  builtinId: string | undefined,
  failure: ProviderHealthFailure
): void {
  const providerKey = normalizeKey(providerId || builtinId)
  if (!providerKey) return
  const record = getOrCreate(providerKey)
  record.failedRequests += 1
  record.consecutiveFailures += 1
  record.lastFailureKind = failure.kind
  record.lastError = sanitizeError(failure.message)
  record.lastStatusCode = failure.statusCode
  record.lastFailedAt = Date.now()
  updateStatus(record)
  record.updatedAt = Date.now()
}

export function classifyProviderFailure(input: {
  statusCode?: number
  error?: string
}): ProviderHealthFailure {
  const statusCode = input.statusCode || 0
  const message = input.error || (statusCode ? `HTTP ${statusCode}` : 'Provider request failed')
  let kind: ProviderFailureKind = 'unknown'
  if (statusCode === 401 || statusCode === 403) kind = 'authentication'
  else if (statusCode === 400 || (statusCode >= 422 && statusCode < 500 && statusCode !== 429)) {
    kind = 'invalid_request'
  } else if (statusCode === 408 || /timed out|timeout/i.test(message)) kind = 'timeout'
  else if (statusCode === 429) kind = 'rate_limit'
  else if (statusCode >= 500) kind = 'server'
  else if (statusCode === 0) kind = 'network'

  return {
    kind,
    message,
    statusCode: statusCode || undefined,
    retryable:
      kind === 'timeout' || kind === 'network' || kind === 'rate_limit' || kind === 'server'
  }
}

export function listProviderHealth(): ProviderHealthSnapshot {
  const providers = Array.from(registry.values())
    .map(({ latencyTotalMs: _latencyTotalMs, ...health }) => ({ ...health }))
    .sort((left, right) => left.providerKey.localeCompare(right.providerKey))
  return { providers, generatedAt: Date.now() }
}

export function resetProviderHealth(providerKey?: string): void {
  const normalized = normalizeKey(providerKey)
  if (!normalized) {
    registry.clear()
    return
  }
  registry.delete(normalized)
}
