import { afterEach, describe, expect, it, vi } from 'vitest'

const notification = vi.hoisted(() => ({
  mode: 'show' as 'show' | 'failed' | 'silent' | 'throw',
  supported: true
}))

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return notification.supported
    }

    private readonly listeners = new Map<string, (...args: unknown[]) => void>()

    once(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, listener)
      return this
    }

    show(): void {
      if (notification.mode === 'throw') throw new Error('NOTIFICATION_UNAVAILABLE')
      if (notification.mode !== 'silent') this.listeners.get(notification.mode)?.({})
    }
  }
}))
vi.mock('../../src/main/window-ipc', () => ({ safeSendMessagePackToAllWindows: vi.fn() }))
vi.mock('../../src/main/ipc/messagepack-handler', () => ({ registerMessagePackHandler: vi.fn() }))

import { showSystemNotification } from '../../src/main/ipc/notify-handlers'

afterEach(() => {
  vi.useRealTimers()
  notification.mode = 'show'
  notification.supported = true
})

describe('Electron desktop notification result', () => {
  it('marks a show event as confirmed', async () => {
    await expect(showSystemNotification('shown', 'result')).resolves.toBe('shown')
  })

  it('marks a failed event and unsupported notifications as failed', async () => {
    notification.mode = 'failed'
    await expect(showSystemNotification('failed', 'result')).resolves.toBe('failed')
    notification.supported = false
    await expect(showSystemNotification('unsupported', 'result')).resolves.toBe('failed')
  })

  it('keeps missing acknowledgment unknown', async () => {
    vi.useFakeTimers()
    notification.mode = 'silent'
    const pending = showSystemNotification('silent', 'result')
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(pending).resolves.toBe('unknown')
  })

  it('marks a synchronous notification error as failed', async () => {
    notification.mode = 'throw'
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(showSystemNotification('throws', 'result')).resolves.toBe('failed')
    } finally {
      consoleSpy.mockRestore()
    }
  })
})
