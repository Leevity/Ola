import { useEffect, useRef, type RefObject } from 'react'
import type { RemoteInputEvent } from '../../../shared/remote-control'

type Point = { x: number; y: number }
type PointerButton = 'left' | 'middle' | 'right'
type HeldKey = { key: string; modifiers: string[] }

/** Mirrors resolveRobotKey in src/main/ipc/desktop-control.ts; a test binds the two. */
export const REMOTE_NAMED_KEYS: ReadonlySet<string> = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space',
  'Control',
  'Shift',
  'Alt',
  'Meta',
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`)
])

const MAX_TEXT_LENGTH = 4096

/**
 * robotjs can only press keys it has a name for, so punctuation has to travel as
 * text instead. Letters and digits stay key events: they carry modifiers, which
 * is what makes Ctrl+C and Shift+A work.
 */
export function classifyRemoteKey(key: string): 'key' | 'text' | null {
  if (key.length === 1) return /[a-zA-Z0-9]/.test(key) ? 'key' : 'text'
  if (REMOTE_NAMED_KEYS.has(key)) return 'key'
  return null
}

type VideoGeometry = {
  rect: { left: number; top: number; width: number; height: number }
  videoWidth: number
  videoHeight: number
}

/**
 * The video element is object-contain, so a non-16:9 remote screen leaves black
 * bars inside it. Mapping against the element rect would offset every click by
 * half a bar; map against the rendered picture instead.
 *
 * clamp is for drags that leave the picture: they should stick to the edge. A
 * hover or a click in the bars is dropped rather than clamped, because sending
 * it would move the remote cursor somewhere the user never pointed at.
 */
export function normalizeVideoPoint(
  geometry: VideoGeometry,
  clientX: number,
  clientY: number,
  clamp: boolean
): Point | null {
  const { rect, videoWidth, videoHeight } = geometry
  if (!videoWidth || !videoHeight || !rect.width || !rect.height) return null
  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight)
  const width = videoWidth * scale
  const height = videoHeight * scale
  const x = (clientX - rect.left - (rect.width - width) / 2) / width
  const y = (clientY - rect.top - (rect.height - height) / 2) / height
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (clamp) {
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
  }
  if (x < 0 || x > 1 || y < 0 || y > 1) return null
  return { x, y }
}

function readGeometry(video: HTMLVideoElement): VideoGeometry {
  const rect = video.getBoundingClientRect()
  return {
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight
  }
}

function pointerButton(button: number): PointerButton | null {
  if (button === 0) return 'left'
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  return null
}

function activeModifiers(event: KeyboardEvent): string[] {
  const held: string[] = []
  if (event.ctrlKey) held.push('Control')
  if (event.altKey) held.push('Alt')
  if (event.shiftKey) held.push('Shift')
  if (event.metaKey) held.push('Meta')
  // Pressing Control itself must not also list Control as its own modifier.
  return held.filter((name) => name !== event.key)
}

/**
 * Forwards controller-side pointer, wheel and keyboard input to the controlled
 * machine. Listeners are native rather than React props because wheel must be
 * non-passive to cancel the local scroll, and because keyboard input has to be
 * scoped to the focused video: typing elsewhere in Ola must never reach the
 * remote machine.
 */
export function useRemoteControllerInput(options: {
  videoRef: RefObject<HTMLVideoElement | null>
  enabled: boolean
  sendInput: (event: RemoteInputEvent) => void
  onError: (message: string) => void
}): void {
  const { videoRef, enabled, sendInput, onError } = options
  const heldKeys = useRef(new Map<string, HeldKey>())
  const heldButtons = useRef(new Map<PointerButton, Point>())
  const pendingMove = useRef<Point | null>(null)
  const moveFrame = useRef(0)
  const callbacks = useRef({ sendInput, onError })
  callbacks.current = { sendInput, onError }

  useEffect(() => {
    const video = videoRef.current
    if (!enabled || !video) return

    const keys = heldKeys.current
    const buttons = heldButtons.current

    const send = (event: RemoteInputEvent): boolean => {
      try {
        callbacks.current.sendInput(event)
        return true
      } catch (error) {
        callbacks.current.onError(error instanceof Error ? error.message : String(error))
        return false
      }
    }

    const cancelPendingMove = (): void => {
      if (moveFrame.current) cancelAnimationFrame(moveFrame.current)
      moveFrame.current = 0
      pendingMove.current = null
    }

    const point = (event: { clientX: number; clientY: number }, clamp: boolean): Point | null =>
      normalizeVideoPoint(readGeometry(video), event.clientX, event.clientY, clamp)

    const releaseAll = (): void => {
      cancelPendingMove()
      for (const { key, modifiers } of keys.values())
        send({ type: 'key', key, action: 'up', modifiers })
      for (const [button, at] of buttons.entries()) {
        send({ type: 'pointerButton', ...at, button, action: 'up' })
      }
      keys.clear()
      buttons.clear()
    }

    const onPointerMove = (event: PointerEvent): void => {
      if (!event.isPrimary) return
      const at = point(event, buttons.size > 0)
      if (!at) return
      // Main drops everything past 300 events/s. Coalescing moves to one per
      // frame keeps that budget available for clicks and keystrokes.
      pendingMove.current = at
      if (!moveFrame.current) {
        moveFrame.current = requestAnimationFrame(() => {
          moveFrame.current = 0
          const next = pendingMove.current
          pendingMove.current = null
          if (next) send({ type: 'pointerMove', ...next })
        })
      }
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (!event.isPrimary) return
      const button = pointerButton(event.button)
      const at = point(event, false)
      if (!button || !at) return
      event.preventDefault()
      video.focus()
      // A drag that leaves the element must still deliver its up, otherwise the
      // remote machine keeps a button held down.
      video.setPointerCapture(event.pointerId)
      cancelPendingMove()
      if (send({ type: 'pointerButton', ...at, button, action: 'down' })) {
        buttons.set(button, at)
      }
    }

    const onPointerUp = (event: PointerEvent): void => {
      if (!event.isPrimary) return
      const button = pointerButton(event.button)
      if (!button || !buttons.has(button)) return
      event.preventDefault()
      if (video.hasPointerCapture(event.pointerId)) video.releasePointerCapture(event.pointerId)
      const at = point(event, true) ?? buttons.get(button)!
      cancelPendingMove()
      send({ type: 'pointerButton', ...at, button, action: 'up' })
      buttons.delete(button)
    }

    const onPointerCancel = (event: PointerEvent): void => {
      if (!event.isPrimary) return
      const button = pointerButton(event.button)
      if (!button || !buttons.has(button)) return
      const at = buttons.get(button)!
      send({ type: 'pointerButton', ...at, button, action: 'up' })
      buttons.delete(button)
    }

    const onWheel = (event: WheelEvent): void => {
      const at = point(event, false)
      if (!at) return
      event.preventDefault()
      send({
        type: 'wheel',
        ...at,
        deltaX: Math.max(-100, Math.min(100, event.deltaX)),
        deltaY: Math.max(-100, Math.min(100, event.deltaY))
      })
    }

    const onContextMenu = (event: MouseEvent): void => {
      // Right-click belongs to the remote machine, not to Ola's own menu.
      event.preventDefault()
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      const kind = classifyRemoteKey(event.key)
      if (!kind) return
      event.preventDefault()
      if (kind === 'text') {
        send({ type: 'text', text: event.key })
        return
      }
      if (event.repeat) return
      const modifiers = activeModifiers(event)
      // Keyed by physical code: event.key changes with Shift, so keying by it
      // would lose the down payload and leave the remote key held.
      if (send({ type: 'key', key: event.key, action: 'down', modifiers })) {
        keys.set(event.code, { key: event.key, modifiers })
      }
    }

    const onKeyUp = (event: KeyboardEvent): void => {
      const held = keys.get(event.code)
      if (!held) return
      event.preventDefault()
      // Replay the down payload verbatim: Main tracks held keys by
      // key+modifiers, so a changed modifier set would leak the entry.
      send({ type: 'key', key: held.key, action: 'up', modifiers: held.modifiers })
      keys.delete(event.code)
    }

    const onPaste = (event: ClipboardEvent): void => {
      const text = event.clipboardData?.getData('text/plain')
      if (!text) return
      event.preventDefault()
      send({ type: 'text', text: text.slice(0, MAX_TEXT_LENGTH) })
    }

    const onBlur = (): void => releaseAll()
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') releaseAll()
    }

    video.addEventListener('pointermove', onPointerMove)
    video.addEventListener('pointerdown', onPointerDown)
    video.addEventListener('pointerup', onPointerUp)
    video.addEventListener('pointercancel', onPointerCancel)
    video.addEventListener('wheel', onWheel, { passive: false })
    video.addEventListener('contextmenu', onContextMenu)
    video.addEventListener('keydown', onKeyDown)
    video.addEventListener('keyup', onKeyUp)
    video.addEventListener('paste', onPaste)
    video.addEventListener('blur', onBlur)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      video.removeEventListener('pointermove', onPointerMove)
      video.removeEventListener('pointerdown', onPointerDown)
      video.removeEventListener('pointerup', onPointerUp)
      video.removeEventListener('pointercancel', onPointerCancel)
      video.removeEventListener('wheel', onWheel)
      video.removeEventListener('contextmenu', onContextMenu)
      video.removeEventListener('keydown', onKeyDown)
      video.removeEventListener('keyup', onKeyUp)
      video.removeEventListener('paste', onPaste)
      video.removeEventListener('blur', onBlur)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      releaseAll()
    }
  }, [enabled, videoRef])
}
