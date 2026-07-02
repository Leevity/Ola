import type { ImageErrorCode } from '@renderer/lib/api/types'

export interface ImageGenerateRetryState {
  status: 'awaiting_retry'
  attempt: number
  completedCount: number
  totalCount: number
  errorMessage: string
}

const retryResolvers = new Map<string, () => void>()

const RETRYABLE_IMAGE_ERROR_PATTERNS = [
  /\b429\b/i,
  /rate\s*limit/i,
  /too\s+many\s+requests/i,
  /resource[_\s-]*exhausted/i,
  /quota\s+exceeded/i,
  /exceeded\s+your\s+current\s+quota/i,
  /请求过于频繁/i,
  /触发限流/i,
  /限流/i,
  /配额已用尽/i
]

export function isRetryableImageError(message: string, code?: ImageErrorCode): boolean {
  if (!message.trim()) return false
  if (code && code !== 'api_error' && code !== 'unknown') return false
  return RETRYABLE_IMAGE_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}

export async function waitForImageGenerateRetry(
  toolUseId: string,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) return false

  return new Promise<boolean>((resolve) => {
    const cleanup = (): void => {
      retryResolvers.delete(toolUseId)
      signal.removeEventListener('abort', onAbort)
    }

    const onAbort = (): void => {
      cleanup()
      resolve(false)
    }

    retryResolvers.set(toolUseId, () => {
      cleanup()
      resolve(true)
    })

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function resolveImageGenerateRetry(toolUseId: string): void {
  const resolve = retryResolvers.get(toolUseId)
  if (!resolve) return
  resolve()
}

export function clearPendingImageGenerateRetries(): void {
  for (const [, resolve] of retryResolvers) {
    resolve()
  }
  retryResolvers.clear()
}
