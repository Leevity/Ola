import type {
  ProviderConfig,
  RequestDebugInfo,
  TokenUsage,
  ToolDefinition,
  UnifiedMessage
} from '@renderer/lib/api/types'
import { estimateTokens } from '@renderer/lib/format-tokens'
import { calculateCacheReadRatio } from '@renderer/lib/agent/cache-shape'

/**
 * Token accounting shared by the request loop and the manual-compaction UI.
 * Everything here is pure: callers pass the transcript and provider config, so
 * both paths measure a request the same way.
 */

export function readPersistedContextLength(usage?: TokenUsage): number {
  return typeof usage?.contextLength === 'number' && usage.contextLength > 0
    ? usage.contextLength
    : 0
}

export function findPersistedContextLength(messages: UnifiedMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const contextLength = readPersistedContextLength(messages[i]?.usage)
    if (contextLength > 0) return contextLength
  }
  return 0
}

export function normalizeUsageForPersistence(
  usage: TokenUsage,
  contextLength?: number
): TokenUsage {
  const normalizedContextLength =
    typeof contextLength === 'number' && contextLength > 0
      ? contextLength
      : readPersistedContextLength(usage)
  const cacheReadRatio = calculateCacheReadRatio(usage)
  const { cacheReadRatio: _cacheReadRatio, ...usageWithoutRatio } = usage

  return {
    ...usageWithoutRatio,
    contextTokens: usage.contextTokens ?? usage.inputTokens,
    ...(normalizedContextLength > 0 ? { contextLength: normalizedContextLength } : {}),
    ...(cacheReadRatio !== undefined ? { cacheReadRatio } : {})
  }
}

function resolveDebugContextWindowPayload(debugInfo?: RequestDebugInfo | null): string | null {
  if (!debugInfo) return null
  if (debugInfo.transport === 'websocket' && debugInfo.websocketRequestKind === 'warmup') {
    return null
  }
  if (typeof debugInfo.contextWindowBody === 'string' && debugInfo.contextWindowBody.trim()) {
    return debugInfo.contextWindowBody
  }
  if (typeof debugInfo.body === 'string' && debugInfo.body.trim()) {
    return debugInfo.body
  }
  return null
}

interface ContextEstimatePayloadInfo {
  serialized: string
  hadBase64Payload: boolean
}

const CONTEXT_ESTIMATE_BASE64_DATA_URL_PATTERN = /^data:([^;,]+);base64,/i
const CONTEXT_ESTIMATE_BASE64_VALUE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/
const CONTEXT_ESTIMATE_BASE64_MIN_LENGTH = 256
const CONTEXT_ESTIMATE_BASE64_PLACEHOLDER = '[base64 omitted]'
const CONTEXT_ESTIMATE_DATA_URL_PLACEHOLDER = '[image omitted]'
const CONTEXT_ESTIMATE_BINARY_KEYS = new Set(['data', 'result'])

function isLikelyBase64Payload(value: string): boolean {
  const normalized = value.replace(/\s+/g, '')
  if (normalized.length < CONTEXT_ESTIMATE_BASE64_MIN_LENGTH) return false
  if (normalized.length % 4 !== 0) return false
  return CONTEXT_ESTIMATE_BASE64_VALUE_PATTERN.test(normalized)
}

function sanitizeContextEstimateString(args: {
  value: string
  key?: string
  parentType?: string
}): { sanitized: string; hadBase64Payload: boolean } {
  const trimmed = args.value.trim()
  if (CONTEXT_ESTIMATE_BASE64_DATA_URL_PATTERN.test(trimmed)) {
    return {
      sanitized: CONTEXT_ESTIMATE_DATA_URL_PLACEHOLDER,
      hadBase64Payload: true
    }
  }

  const shouldSanitizeRawBase64 =
    (CONTEXT_ESTIMATE_BINARY_KEYS.has(args.key ?? '') ||
      (args.parentType === 'image_generation_call' && args.key === 'result')) &&
    isLikelyBase64Payload(trimmed)
  if (shouldSanitizeRawBase64) {
    return {
      sanitized: CONTEXT_ESTIMATE_BASE64_PLACEHOLDER,
      hadBase64Payload: true
    }
  }

  return {
    sanitized: args.value,
    hadBase64Payload: false
  }
}

function sanitizeContextEstimateValue(
  value: unknown,
  key?: string,
  parentType?: string
): { sanitized: unknown; hadBase64Payload: boolean } {
  if (typeof value === 'string') {
    const sanitized = sanitizeContextEstimateString({ value, key, parentType })
    return {
      sanitized: sanitized.sanitized,
      hadBase64Payload: sanitized.hadBase64Payload
    }
  }

  if (Array.isArray(value)) {
    let hadBase64Payload = false
    const sanitized = value.map((entry) => {
      const next = sanitizeContextEstimateValue(entry, key, parentType)
      hadBase64Payload ||= next.hadBase64Payload
      return next.sanitized
    })
    return { sanitized, hadBase64Payload }
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const childParentType = typeof record.type === 'string' ? record.type : parentType
    let hadBase64Payload = false
    const sanitized: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(record)) {
      const next = sanitizeContextEstimateValue(childValue, childKey, childParentType)
      sanitized[childKey] = next.sanitized
      hadBase64Payload ||= next.hadBase64Payload
    }
    return { sanitized, hadBase64Payload }
  }

  return { sanitized: value, hadBase64Payload: false }
}

function serializeContextEstimatePayload(value: unknown): ContextEstimatePayloadInfo {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      const sanitized = sanitizeContextEstimateValue(parsed)
      return {
        serialized: JSON.stringify(sanitized.sanitized),
        hadBase64Payload: sanitized.hadBase64Payload
      }
    } catch {
      const sanitized = sanitizeContextEstimateString({ value })
      return {
        serialized: sanitized.sanitized,
        hadBase64Payload: sanitized.hadBase64Payload
      }
    }
  }

  try {
    const sanitized = sanitizeContextEstimateValue(value)
    return {
      serialized: JSON.stringify(sanitized.sanitized),
      hadBase64Payload: sanitized.hadBase64Payload
    }
  } catch {
    return {
      serialized: String(value ?? ''),
      hadBase64Payload: false
    }
  }
}

function resolveDebugContextEstimatePayload(
  debugInfo?: RequestDebugInfo | null
): ContextEstimatePayloadInfo | null {
  const payload = resolveDebugContextWindowPayload(debugInfo)
  return payload ? serializeContextEstimatePayload(payload) : null
}

export function shouldUseEstimatedContextTokens(debugInfo?: RequestDebugInfo | null): boolean {
  return debugInfo?.transport === 'websocket' && !!resolveDebugContextWindowPayload(debugInfo)
}

export function estimateContextTokensForRequest(args: {
  messages: UnifiedMessage[]
  tools: ToolDefinition[]
  providerConfig: ProviderConfig
}): number {
  if (args.messages.length === 0) return 0

  try {
    const payload = {
      systemPrompt: args.providerConfig.systemPrompt ?? '',
      messages: args.messages,
      ...(args.tools.length > 0 ? { tools: args.tools } : {})
    }
    return estimateTokens(serializeContextEstimatePayload(payload).serialized)
  } catch (error) {
    console.warn('[ChatActions] Failed to estimate request context tokens', error)
    return 0
  }
}

function findRecentInputTokenUsage(messages: UnifiedMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const usage = messages[index]?.usage
    if (!usage) continue

    const contextTokens = usage.contextTokens
    if (typeof contextTokens === 'number' && Number.isFinite(contextTokens) && contextTokens > 0) {
      return Math.floor(contextTokens)
    }

    const inputTokens = usage.inputTokens
    if (typeof inputTokens === 'number' && Number.isFinite(inputTokens) && inputTokens > 0) {
      return Math.floor(inputTokens)
    }
  }

  return 0
}

export function estimateManualCompressionInputTokens(
  messages: UnifiedMessage[],
  providerConfig: ProviderConfig
): number {
  const reportedTokens = findRecentInputTokenUsage(messages)
  if (reportedTokens > 0) return reportedTokens

  return estimateContextTokensForRequest({
    messages,
    tools: [],
    providerConfig
  })
}

export function estimateContextTokensFromDebugInfo(debugInfo?: RequestDebugInfo | null): {
  tokenCount: number
  hadBase64Payload: boolean
} {
  const payload = resolveDebugContextEstimatePayload(debugInfo)
  if (!payload) {
    return {
      tokenCount: 0,
      hadBase64Payload: false
    }
  }

  try {
    return {
      tokenCount: estimateTokens(payload.serialized),
      hadBase64Payload: payload.hadBase64Payload
    }
  } catch (error) {
    console.warn('[ChatActions] Failed to estimate debug context tokens', error)
    return {
      tokenCount: 0,
      hadBase64Payload: payload.hadBase64Payload
    }
  }
}

export function normalizeUsageWithEstimatedContext(args: {
  usage: TokenUsage
  contextLength?: number
  debugInfo?: RequestDebugInfo | null
  estimatedContextTokens?: number
  preferEstimatedContextTokens?: boolean
}): TokenUsage {
  const normalized = normalizeUsageForPersistence(args.usage, args.contextLength)
  const estimatedContextTokens = args.estimatedContextTokens ?? 0
  if (shouldUseEstimatedContextTokens(args.debugInfo) && estimatedContextTokens > 0) {
    normalized.contextTokens = args.preferEstimatedContextTokens
      ? estimatedContextTokens
      : Math.max(normalized.contextTokens ?? normalized.inputTokens, estimatedContextTokens)
  }
  return normalized
}

export function buildStreamingContextUsage(
  contextTokens: number,
  contextLength?: number
): TokenUsage | null {
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
    return null
  }

  return {
    inputTokens: 0,
    outputTokens: 0,
    contextTokens,
    ...(typeof contextLength === 'number' && contextLength > 0 ? { contextLength } : {})
  }
}
