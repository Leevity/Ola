import { useEffect, useRef, useState } from 'react'
import RFB from '@novnc/novnc'
import { useTranslation } from 'react-i18next'
import { Maximize2, Minimize2, Monitor } from 'lucide-react'
import type { RemoteConnection, RemoteViewerCredential } from '@renderer/lib/remote/remote-types'
import { useRemoteStore } from '@renderer/stores/remote-store'

type ScaleMode = 'contain' | 'fill' | 'original'

export function NoVncViewer({
  sessionId,
  viewerUrl,
  connection,
  onStatusChange
}: {
  sessionId: string
  viewerUrl: string
  connection?: RemoteConnection
  onStatusChange?: (status: 'connecting' | 'connected' | 'disconnected' | 'error') => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const targetRef = useRef<HTMLDivElement | null>(null)
  const credentialPromiseRef = useRef<Promise<RemoteViewerCredential | null> | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>(
    'connecting'
  )
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState('connecting')
  const [scaleMode, setScaleMode] = useState<ScaleMode>('contain')
  const [framebufferSize, setFramebufferSize] = useState<{ width: number; height: number } | null>(
    null
  )
  // Live scale mode for the layout closure (avoids stale state) plus a handle so
  // the toolbar can re-apply the layout after a scale change.
  const scaleModeRef = useRef<ScaleMode>('contain')
  const applyLayoutRef = useRef<(() => void) | null>(null)
  scaleModeRef.current = scaleMode

  // Derived VNC tuning, held in a ref so the connect effect reads the latest
  // values without forcing a reconnect when the connection prop identity changes.
  const connectionRef = useRef<RemoteConnection | undefined>(connection)
  connectionRef.current = connection

  useEffect(() => {
    const target = targetRef.current
    if (!target) return undefined

    let disposed = false
    let rfb: RFB | null = null
    let handshakeTimer: number | null = null
    let terminalError = false
    onStatusChange?.('connecting')

    const showFailure = (event?: Event | { detail?: unknown }): void => {
      if (disposed) return
      terminalError = true
      if (handshakeTimer !== null) window.clearTimeout(handshakeTimer)
      setPhase('security failure')
      setStatus('error')
      onStatusChange?.('error')
      const detail =
        event && typeof event === 'object' && 'detail' in event ? String(event.detail ?? '') : ''
      setError(
        t('remote.noVncSecurityFailure', {
          detail,
          defaultValue: 'The VNC server rejected the connection security handshake.{{detail}}'
        })
      )
    }

    const connect = async (): Promise<void> => {
      credentialPromiseRef.current ??= useRemoteStore.getState().claimViewerCredential(sessionId)
      const credential = await credentialPromiseRef.current
      if (disposed) return
      if (!credential?.password) {
        terminalError = true
        setPhase('credential unavailable')
        setStatus('error')
        onStatusChange?.('error')
        setError(
          t('remote.noVncCredentialsRequired', {
            defaultValue: 'The saved VNC password is unavailable.'
          })
        )
        return
      }

      setPhase('waiting for VNC authentication')
      target.style.display = 'flex'
      target.style.flexDirection = 'column'
      target.style.position = 'relative'
      target.style.width = '100%'
      target.style.height = '100%'
      rfb = new RFB(target, viewerUrl, { shared: true })
      rfb.scaleViewport = true
      // macOS Screen Sharing commonly implements RFB framebuffer updates but not
      // the ExtendedDesktopSize resize request used by noVNC.
      rfb.resizeSession = false
      rfb.background = '#000000'
      // Apply the per-connection quality/compression tuning. These drive Tight
      // encoding on the server side; a balanced default keeps the picture sharp
      // without saturating the link, which is what causes the mosaic fallback.
      const cfg = connectionRef.current?.vnc
      const rawQ = cfg?.quality ?? 6
      rfb.qualityLevel = Math.min(9, Math.max(0, rawQ))
      rfb.compressionLevel = cfg?.encoding === 'raw' ? 0 : 7
      rfb.viewOnly = Boolean(cfg?.viewOnly)

      const credentialsRequired = (): void => {
        setPhase('sending VNC password')
        rfb?.sendCredentials({
          username: credential.username || undefined,
          password: credential.password
        })
      }
      const applyCanvasLayout = (): void => {
        const screen = target.firstElementChild as HTMLElement | null
        const canvas = screen?.querySelector('canvas') as HTMLCanvasElement | null
        if (!screen || !canvas) return
        // Keep noVNC's screen as a normal flex child so _screenSize() (which
        // reads screen.getBoundingClientRect()) sees the real container size.
        // Absolute positioning detaches it from the layout and collapses it to
        // a tiny width, which then scales a 16:9 framebuffer into a narrow strip.
        screen.style.position = 'static'
        screen.style.width = '100%'
        screen.style.height = '100%'
        screen.style.minWidth = '1px'
        screen.style.minHeight = '1px'
        screen.style.display = 'flex'
        screen.style.alignItems = 'center'
        screen.style.justifyContent = 'center'
        const mode = scaleModeRef.current
        if (mode === 'fill') {
          // Stretch to fill the viewport; ignores aspect ratio. Useful when the
          // framebuffer and window differ and the user wants full coverage.
          canvas.style.width = '100%'
          canvas.style.height = '100%'
          canvas.style.maxWidth = 'none'
          canvas.style.maxHeight = 'none'
          canvas.style.minWidth = '0'
          canvas.style.minHeight = '0'
          canvas.style.objectFit = 'fill'
        } else if (mode === 'original') {
          // Render at the framebuffer's native pixel size, no scaling.
          canvas.style.width = 'auto'
          canvas.style.height = 'auto'
          canvas.style.maxWidth = 'none'
          canvas.style.maxHeight = 'none'
          canvas.style.minWidth = '0'
          canvas.style.minHeight = '0'
          canvas.style.objectFit = 'none'
        } else {
          // Default: scale down proportionally to fit, preserving aspect ratio.
          canvas.style.width = 'auto'
          canvas.style.height = 'auto'
          canvas.style.maxWidth = '100%'
          canvas.style.maxHeight = '100%'
          canvas.style.minWidth = '0'
          canvas.style.minHeight = '0'
          canvas.style.objectFit = 'contain'
        }
      }
      applyLayoutRef.current = applyCanvasLayout
      const connected = (): void => {
        if (handshakeTimer !== null) window.clearTimeout(handshakeTimer)
        applyCanvasLayout()
        window.requestAnimationFrame(() => {
          if (disposed) return
          // noVNC has already calculated its viewport. Re-apply only our CSS
          // layout once; toggling scaleViewport here causes an unnecessary
          // canvas/backbuffer rescale on every connection.
          applyCanvasLayout()
        })
        const screen = target.firstElementChild as HTMLElement | null
        const canvas = screen?.querySelector('canvas') as HTMLCanvasElement | null
        if (canvas?.width && canvas?.height) {
          setFramebufferSize({ width: canvas.width, height: canvas.height })
        }
        setPhase(
          `framebuffer ready ${canvas?.width ?? 0}x${canvas?.height ?? 0} / ${canvas?.clientWidth ?? 0}x${canvas?.clientHeight ?? 0}`
        )
        setStatus('connected')
        onStatusChange?.('connected')
      }
      const disconnected = (): void => {
        if (handshakeTimer !== null) window.clearTimeout(handshakeTimer)
        if (terminalError) return
        setPhase('disconnected before framebuffer')
        setStatus('disconnected')
        onStatusChange?.('disconnected')
      }
      rfb.addEventListener('credentialsrequired', credentialsRequired)
      rfb.addEventListener('connect', connected)
      rfb.addEventListener('disconnect', disconnected)
      const serverInit = (): void => {
        const screen = target.firstElementChild as HTMLElement | null
        const canvas = screen?.querySelector('canvas')
        if (canvas?.width && canvas?.height) {
          setFramebufferSize({ width: canvas.width, height: canvas.height })
        }
        setPhase(
          `server init ${canvas?.width ?? 0}x${canvas?.height ?? 0} / ${canvas?.clientWidth ?? 0}x${canvas?.clientHeight ?? 0}`
        )
      }
      rfb.addEventListener('desktopname', serverInit)
      rfb.addEventListener('securityfailure', showFailure)
      rfb.addEventListener('error', showFailure)
      // macOS Screen Sharing only honours the explicit CapsLock modifier event.
      // noVNC only emits XK_Caps_Lock when the CapsLock key itself is pressed;
      // macOS toggles the OS state via a release-only event so the remote end
      // never sees the modifier flip. Bridge the OS state into explicit RFB
      // modifier events whenever caps lock toggles.
      const XK_CAPS_LOCK = 0xffe5
      const syncCapsLock = (event: KeyboardEvent): void => {
        if (!rfb) return
        const capslock = event.getModifierState('CapsLock')
        if (capslock === syncCapsLock.last) return
        syncCapsLock.last = capslock
        rfb.sendKey(XK_CAPS_LOCK, 'CapsLock', true)
        window.setTimeout(() => {
          rfb?.sendKey(XK_CAPS_LOCK, 'CapsLock', false)
        }, 30)
      }
      syncCapsLock.last = false
      const handleCapsLockEvent = (event: KeyboardEvent): void => {
        syncCapsLock(event)
      }
      target.addEventListener('keydown', handleCapsLockEvent, true)
      target.addEventListener('keyup', handleCapsLockEvent, true)
      // Focus once after noVNC has installed its canvas. A DOM observer is not
      // needed for framebuffer updates and would run on the rendering path.
      target.focus({ preventScroll: true })
      target.querySelector('canvas')?.focus({ preventScroll: true })
      handshakeTimer = window.setTimeout(() => {
        if (disposed || terminalError) return
        terminalError = true
        setPhase('handshake timeout')
        setStatus('error')
        onStatusChange?.('error')
        setError(
          t('remote.noVncConnectionTimeout', {
            defaultValue:
              'The VNC server did not complete the handshake within 12 seconds. Check the Mac Screen Sharing permission, VNC password, and port 5900.'
          })
        )
        rfb?.disconnect()
      }, 12_000)
      rfb.focus()

      const cleanup = (): void => {
        applyLayoutRef.current = null
        target.removeEventListener('keydown', handleCapsLockEvent, true)
        target.removeEventListener('keyup', handleCapsLockEvent, true)
        rfb?.removeEventListener('credentialsrequired', credentialsRequired)
        rfb?.removeEventListener('connect', connected)
        rfb?.removeEventListener('disconnect', disconnected)
        rfb?.removeEventListener('desktopname', serverInit)
        rfb?.removeEventListener('securityfailure', showFailure)
        rfb?.removeEventListener('error', showFailure)
      }
      cleanupRef.current = cleanup
    }

    const cleanupRef = { current: (): void => undefined }
    void connect().catch(showFailure)
    return () => {
      disposed = true
      if (handshakeTimer !== null) window.clearTimeout(handshakeTimer)
      cleanupRef.current()
      rfb?.disconnect()
    }
  }, [onStatusChange, sessionId, t, viewerUrl])

  // Re-apply the canvas layout whenever the user changes the scale mode. The
  // layout closure is registered by the connect effect above.
  useEffect(() => {
    applyLayoutRef.current?.()
  }, [scaleMode])

  const cycleScaleMode = (): void => {
    setScaleMode((current) =>
      current === 'contain' ? 'fill' : current === 'fill' ? 'original' : 'contain'
    )
  }

  const scaleLabel =
    scaleMode === 'fill'
      ? t('remote.scaleFill', { defaultValue: 'Fill' })
      : scaleMode === 'original'
        ? t('remote.scaleOriginal', { defaultValue: '100%' })
        : t('remote.scaleFit', { defaultValue: 'Fit' })

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border bg-black shadow-sm">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-xs text-white/70">
        <span>{t('remote.embeddedNoVnc', { defaultValue: 'Embedded noVNC' })}</span>
        <span className="flex items-center gap-3">
          {framebufferSize ? (
            <span className="font-mono text-white/45">
              {framebufferSize.width}×{framebufferSize.height}
            </span>
          ) : null}
          <button
            type="button"
            onClick={cycleScaleMode}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            title={t('remote.cycleScaleMode', { defaultValue: 'Switch scale mode' })}
          >
            {scaleMode === 'original' ? (
              <Maximize2 className="size-3" />
            ) : scaleMode === 'fill' ? (
              <Minimize2 className="size-3" />
            ) : (
              <Monitor className="size-3" />
            )}
            <span>{scaleLabel}</span>
          </button>
          <span>
            {t(`remote.status${status.charAt(0).toUpperCase()}${status.slice(1)}`, {
              defaultValue: status
            })}{' '}
            <span className="text-white/45">({phase})</span>
          </span>
        </span>
      </div>
      {error ? (
        <div className="bg-destructive/15 px-4 py-3 text-xs text-red-200">{error}</div>
      ) : null}
      <div ref={targetRef} className="flex min-h-0 min-w-0 flex-1 overflow-hidden" />
    </div>
  )
}
