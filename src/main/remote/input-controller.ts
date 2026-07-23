import { screen } from 'electron'
import type { RemoteInputEnvelope, RemoteInputEvent } from '../../shared/remote-control'
import {
  desktopInputClick,
  desktopInputMove,
  desktopInputScroll,
  desktopInputType
} from '../ipc/desktop-control'
import {
  isInputSessionAuthorized,
  setAuthorizedInputSession,
  subscribeRemoteControlRevoked
} from './authorization-state'

const MAX_TEXT_LENGTH = 4096
const MAX_EVENTS_PER_SECOND = 300

let enabledDisplayId: string | null = null
let enabledOwnerWebContentsId: number | null = null
let rateWindowStartedAt = 0
let rateWindowCount = 0
const heldKeys = new Map<string, { key: string; modifiers: string[] }>()
const heldPointerButtons = new Map<'left' | 'middle' | 'right', { x: number; y: number }>()

function releaseHeldRemoteInputs(): void {
  for (const { key, modifiers } of heldKeys.values()) {
    desktopInputType({ key, action: 'up', modifiers })
  }
  for (const [button, point] of heldPointerButtons) {
    desktopInputClick({ ...point, button, action: 'up' })
  }
  heldKeys.clear()
  heldPointerButtons.clear()
}

subscribeRemoteControlRevoked(releaseHeldRemoteInputs)

function hasOnlyKeys(value: object, allowed: string[]): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(value).every((key) => allowedSet.has(key))
}

function normalizedPoint(x: number, y: number): { x: number; y: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null
  const display =
    screen.getAllDisplays().find((item) => String(item.id) === enabledDisplayId) ??
    screen.getPrimaryDisplay()
  const bounds = display.bounds
  return {
    x: bounds.x + Math.min(bounds.width - 1, Math.round(x * bounds.width)),
    y: bounds.y + Math.min(bounds.height - 1, Math.round(y * bounds.height))
  }
}

function consumeRateLimit(): boolean {
  const now = Date.now()
  if (now - rateWindowStartedAt >= 1000) {
    rateWindowStartedAt = now
    rateWindowCount = 0
  }
  rateWindowCount += 1
  return rateWindowCount <= MAX_EVENTS_PER_SECOND
}

export function setRemoteInputSession(
  sessionId: string | null,
  displayId: string | null = null,
  ownerWebContentsId?: number
): void {
  if (sessionId !== null && (typeof sessionId !== 'string' || sessionId.length > 128)) {
    throw new Error('Invalid remote input session ID')
  }
  const normalizedSessionId = sessionId?.trim() || null
  if (normalizedSessionId && (!Number.isInteger(ownerWebContentsId) || ownerWebContentsId! <= 0)) {
    throw new Error('Remote input owner is required')
  }
  releaseHeldRemoteInputs()
  setAuthorizedInputSession(normalizedSessionId)
  enabledDisplayId = normalizedSessionId ? displayId : null
  enabledOwnerWebContentsId = normalizedSessionId ? ownerWebContentsId! : null
  rateWindowStartedAt = Date.now()
  rateWindowCount = 0
}

export function isRemoteInputSessionOwnedBy(
  sessionId: string,
  ownerWebContentsId: number
): boolean {
  return enabledOwnerWebContentsId === ownerWebContentsId && isInputSessionAuthorized(sessionId)
}

export function clearRemoteInputSession(ownerWebContentsId: number): boolean {
  if (enabledOwnerWebContentsId !== null && enabledOwnerWebContentsId !== ownerWebContentsId) {
    return false
  }
  setRemoteInputSession(null)
  return true
}

export function clearRemoteInputSessionIfOwned(
  sessionId: string,
  ownerWebContentsId: number
): boolean {
  if (enabledOwnerWebContentsId !== ownerWebContentsId || !isInputSessionAuthorized(sessionId)) {
    return false
  }
  setRemoteInputSession(null)
  return true
}

export function dispatchRemoteInput(
  envelope: RemoteInputEnvelope
): { success: true } | { success: false; error: string } {
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    !hasOnlyKeys(envelope, ['sessionId', 'event']) ||
    typeof envelope.sessionId !== 'string' ||
    envelope.sessionId.length > 128
  ) {
    return { success: false, error: 'Invalid remote input envelope.' }
  }
  if (!isInputSessionAuthorized(envelope.sessionId)) {
    return { success: false, error: 'Remote input is not enabled for this session.' }
  }
  if (!consumeRateLimit()) return { success: false, error: 'Remote input rate limit exceeded.' }
  const event = envelope.event as RemoteInputEvent
  if (!event || typeof event !== 'object') return { success: false, error: 'Invalid input event.' }

  if (event.type === 'pointerMove') {
    if (!hasOnlyKeys(event, ['type', 'x', 'y']))
      return { success: false, error: 'Invalid pointer event.' }
    const point = normalizedPoint(event.x, event.y)
    return point
      ? desktopInputMove(point.x, point.y)
      : { success: false, error: 'Invalid pointer.' }
  }
  if (event.type === 'pointerButton') {
    if (
      !hasOnlyKeys(event, ['type', 'x', 'y', 'button', 'action']) ||
      !['left', 'middle', 'right'].includes(event.button) ||
      !['down', 'up'].includes(event.action)
    ) {
      return { success: false, error: 'Invalid pointer button event.' }
    }
    const point = normalizedPoint(event.x, event.y)
    if (!point) return { success: false, error: 'Invalid pointer.' }
    const result = desktopInputClick({ ...point, button: event.button, action: event.action })
    if (result.success) {
      if (event.action === 'down') heldPointerButtons.set(event.button, point)
      else heldPointerButtons.delete(event.button)
    }
    return result
  }
  if (event.type === 'wheel') {
    if (!hasOnlyKeys(event, ['type', 'x', 'y', 'deltaX', 'deltaY'])) {
      return { success: false, error: 'Invalid wheel event.' }
    }
    const point = normalizedPoint(event.x, event.y)
    if (!point || !Number.isFinite(event.deltaX) || !Number.isFinite(event.deltaY)) {
      return { success: false, error: 'Invalid wheel event.' }
    }
    return desktopInputScroll({
      ...point,
      scrollX: Math.max(-100, Math.min(100, event.deltaX)),
      scrollY: Math.max(-100, Math.min(100, event.deltaY))
    })
  }
  if (event.type === 'key') {
    const modifiers = event.modifiers ?? []
    if (
      !hasOnlyKeys(event, ['type', 'key', 'action', 'modifiers']) ||
      typeof event.key !== 'string' ||
      event.key.length > 32 ||
      !['down', 'up'].includes(event.action) ||
      !Array.isArray(modifiers) ||
      modifiers.length > 4 ||
      new Set(modifiers).size !== modifiers.length ||
      modifiers.some((modifier) => !['Control', 'Alt', 'Shift', 'Meta'].includes(modifier))
    ) {
      return { success: false, error: 'Invalid key event.' }
    }
    const result = desktopInputType({ key: event.key, action: event.action, modifiers })
    if (result.success) {
      const heldKey = `${event.key}\u0000${modifiers.join('\u0000')}`
      if (event.action === 'down') heldKeys.set(heldKey, { key: event.key, modifiers })
      else heldKeys.delete(heldKey)
    }
    return result
  }
  if (event.type === 'text') {
    if (
      !hasOnlyKeys(event, ['type', 'text']) ||
      typeof event.text !== 'string' ||
      event.text.length > MAX_TEXT_LENGTH
    ) {
      return { success: false, error: 'Invalid text event.' }
    }
    return desktopInputType({ text: event.text })
  }
  return { success: false, error: 'Unsupported remote input event.' }
}
