import { Notification } from 'electron'
import { safeSendMessagePackToAllWindows } from '../window-ipc'
import { registerMessagePackHandler } from './messagepack-handler'

// Deduplication cache to prevent duplicate notifications
const notificationCache = new Map<string, number>()
const DEBOUNCE_MS = 2000 // Prevent same notification within 2 seconds
const NOTIFICATION_RESULT_TIMEOUT_MS = 2000

export type DesktopNotificationOutcome = 'shown' | 'failed' | 'unknown'

// Send a system notification using Electron's native Notification API
export function showSystemNotification(
  title: string,
  body: string
): Promise<DesktopNotificationOutcome> {
  if (!Notification.isSupported()) return Promise.resolve('failed')
  // Create a cache key from title + body
  const cacheKey = `${title}:${body}`
  const now = Date.now()
  const lastShown = notificationCache.get(cacheKey)

  // Skip if same notification was shown recently
  if (lastShown && now - lastShown < DEBOUNCE_MS) {
    console.log('[Notify] Skipping duplicate notification')
    return Promise.resolve('unknown')
  }

  // Update cache
  notificationCache.set(cacheKey, now)

  // Clean up old cache entries (older than 5 seconds)
  for (const [key, timestamp] of notificationCache.entries()) {
    if (now - timestamp > 5000) {
      notificationCache.delete(key)
    }
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: DesktopNotificationOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (outcome === 'failed') notificationCache.delete(cacheKey)
      resolve(outcome)
    }
    const timer = setTimeout(() => finish('unknown'), NOTIFICATION_RESULT_TIMEOUT_MS)
    try {
      const notification = new Notification({
        title,
        body,
        silent: false,
        urgency: 'critical',
        timeoutType: 'default'
      })
      notification.once('show', () => finish('shown'))
      notification.once('failed', () => finish('failed'))
      notification.show()
    } catch (error) {
      console.error('[Notify] Notification request failed:', error)
      finish('failed')
    }
  })
}

export function registerNotifyHandlers(): void {
  registerMessagePackHandler<
    { title: string; body: string; type?: string; duration?: number },
    { success: boolean; status: DesktopNotificationOutcome; error?: string }
  >('notify:desktop', async (args) => {
    try {
      const status = await showSystemNotification(args.title ?? 'Ola', args.body ?? '')
      return status === 'failed'
        ? { success: false, status, error: 'NOTIFICATION_FAILED' }
        : { success: true, status }
    } catch (err) {
      return {
        success: false,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  registerMessagePackHandler<
    { sessionId: string; title: string; body: string },
    { success: boolean; error?: string }
  >('notify:session', async (args) => {
    try {
      if (!args?.sessionId) {
        return { success: false, error: 'sessionId is required' }
      }
      const payload = {
        sessionId: args.sessionId,
        title: args.title ?? 'Ola',
        body: args.body ?? ''
      }
      safeSendMessagePackToAllWindows('notify:session-message', payload)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
