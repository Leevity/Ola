import { useEffect, useRef, useState } from 'react'
import initIronRdp, {
  DesktopSize,
  DeviceEvent,
  Extension,
  InputTransaction,
  IronError,
  IronErrorKind,
  RotationUnit,
  SessionBuilder,
  setup,
  type Session
} from 'ironrdp-wasm'
import ironRdpWasmUrl from '../../../../../node_modules/ironrdp-wasm/pkg/rdp_client_bg.wasm?url'
import { useTranslation } from 'react-i18next'
import type { RemoteSession, RemoteViewerCredential } from '@renderer/lib/remote/remote-types'
import { useRemoteStore } from '@renderer/stores/remote-store'

const SCANCODES: Record<string, number> = {
  Escape: 0x01,
  Digit1: 0x02,
  Digit2: 0x03,
  Digit3: 0x04,
  Digit4: 0x05,
  Digit5: 0x06,
  Digit6: 0x07,
  Digit7: 0x08,
  Digit8: 0x09,
  Digit9: 0x0a,
  Digit0: 0x0b,
  Minus: 0x0c,
  Equal: 0x0d,
  Backspace: 0x0e,
  Tab: 0x0f,
  KeyQ: 0x10,
  KeyW: 0x11,
  KeyE: 0x12,
  KeyR: 0x13,
  KeyT: 0x14,
  KeyY: 0x15,
  KeyU: 0x16,
  KeyI: 0x17,
  KeyO: 0x18,
  KeyP: 0x19,
  BracketLeft: 0x1a,
  BracketRight: 0x1b,
  Enter: 0x1c,
  ControlLeft: 0x1d,
  KeyA: 0x1e,
  KeyS: 0x1f,
  KeyD: 0x20,
  KeyF: 0x21,
  KeyG: 0x22,
  KeyH: 0x23,
  KeyJ: 0x24,
  KeyK: 0x25,
  KeyL: 0x26,
  Semicolon: 0x27,
  Quote: 0x28,
  Backquote: 0x29,
  ShiftLeft: 0x2a,
  Backslash: 0x2b,
  KeyZ: 0x2c,
  KeyX: 0x2d,
  KeyC: 0x2e,
  KeyV: 0x2f,
  KeyB: 0x30,
  KeyN: 0x31,
  KeyM: 0x32,
  Comma: 0x33,
  Period: 0x34,
  Slash: 0x35,
  ShiftRight: 0x36,
  AltLeft: 0x38,
  Space: 0x39,
  CapsLock: 0x3a,
  F1: 0x3b,
  F2: 0x3c,
  F3: 0x3d,
  F4: 0x3e,
  F5: 0x3f,
  F6: 0x40,
  F7: 0x41,
  F8: 0x42,
  F9: 0x43,
  F10: 0x44,
  F11: 0x57,
  F12: 0x58,
  ControlRight: 0xe01d,
  AltRight: 0xe038,
  Home: 0xe047,
  ArrowUp: 0xe048,
  PageUp: 0xe049,
  ArrowLeft: 0xe04b,
  ArrowRight: 0xe04d,
  End: 0xe04f,
  ArrowDown: 0xe050,
  PageDown: 0xe051,
  Insert: 0xe052,
  Delete: 0xe053,
  MetaLeft: 0xe05b,
  MetaRight: 0xe05c
}

const RESOLUTION_OPTIONS = [
  { value: 'adaptive', width: 0, height: 0 },
  { value: '1920x1080', width: 1920, height: 1080 },
  { value: '1600x900', width: 1600, height: 900 },
  { value: '1440x900', width: 1440, height: 900 },
  { value: '1366x768', width: 1366, height: 768 },
  { value: '1280x720', width: 1280, height: 720 },
  { value: '1024x768', width: 1024, height: 768 }
] as const

function applyEvent(session: Session, event: DeviceEvent): void {
  const transaction = new InputTransaction()
  transaction.addEvent(event)
  session.applyInputs(transaction)
}

type RdpStage = 'credential' | 'engine' | 'bridge' | 'authentication' | 'desktop'

function stringifyRdpFailure(reason: unknown): string {
  if (reason instanceof Error) return reason.message || reason.name
  if (typeof reason === 'string') return reason
  if (reason == null) return 'Unknown error'
  if (typeof reason !== 'object') return String(reason)

  if (reason instanceof IronError) {
    const kind = reason.kind()
    const kindName = IronErrorKind[kind] ?? `Unknown (${kind})`
    const details = reason.rdcleanpathDetails()
    const detailParts = [
      `IronRDP error: ${kindName}`,
      details?.httpStatusCode != null ? `HTTP ${details.httpStatusCode}` : null,
      details?.wsaErrorCode != null ? `WSA ${details.wsaErrorCode}` : null,
      details?.tlsAlertCode != null ? `TLS alert ${details.tlsAlertCode}` : null,
      reason.backtrace() || null
    ].filter((item): item is string => Boolean(item))
    return detailParts.join(' · ')
  }

  const value = reason as Record<string, unknown>
  const preferredKeys = ['message', 'error', 'reason', 'description', 'details', 'kind', 'code']
  const parts = preferredKeys
    .filter((key) => value[key] != null)
    .map((key) => {
      const item = value[key]
      return typeof item === 'string' ? item : `${key}: ${safeJson(item)}`
    })
  if (parts.length > 0) return [...new Set(parts)].join(' · ')
  return safeJson(reason)
}

function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value)
    if (json && json !== '{}') return json
    const properties = Object.getOwnPropertyNames(value as object)
    if (properties.length > 0) {
      return properties
        .map((key) => `${key}: ${String((value as Record<string, unknown>)[key])}`)
        .join(' · ')
    }
  } catch {
    // Fall through to a stable message below.
  }
  return 'The RDP engine returned an error without details.'
}

function classifyRdpFailure(
  reason: unknown,
  stage: RdpStage,
  t: ReturnType<typeof useTranslation>['t']
): { title: string; message: string; detail: string } {
  const detail = stringifyRdpFailure(reason)
  const normalized = detail.toLowerCase()
  if (/logon|credential|password|username|credssp|authentication|access.?denied/.test(normalized)) {
    return {
      title: t('remote.rdpAuthFailed'),
      message: t('remote.rdpAuthFailedHint'),
      detail
    }
  }
  if (
    /refused|unreachable|timed? ?out|timeout|network|socket|websocket|connection|proxyconnect|rdcleanpath|wsa/.test(
      normalized
    )
  ) {
    return {
      title: t('remote.rdpNetworkFailed'),
      message: t('remote.rdpNetworkFailedHint'),
      detail
    }
  }
  if (/certificate|tls|ssl|negotiationfailure/.test(normalized)) {
    return {
      title: t('remote.rdpSecurityFailed'),
      message: t('remote.rdpSecurityFailedHint'),
      detail
    }
  }
  return {
    title: t('remote.rdpStageFailed', { stage: t(`remote.rdpStage.${stage}`) }),
    message: t('remote.rdpUnknownFailedHint'),
    detail
  }
}

export function IronRdpViewer({
  remoteSession,
  onStatusChange
}: {
  remoteSession: RemoteSession
  onStatusChange?: (status: 'connecting' | 'connected' | 'disconnected' | 'error') => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sessionRef = useRef<Session | null>(null)
  const credentialPromiseRef = useRef<Promise<RemoteViewerCredential | null> | null>(null)
  const resolutionModeRef = useRef('adaptive')
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>(
    'connecting'
  )
  const [error, setError] = useState<string | null>(null)
  const [errorTitle, setErrorTitle] = useState<string | null>(null)
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const [stage, setStage] = useState<RdpStage>('credential')
  const [desktopSize, setDesktopSize] = useState<{ width: number; height: number } | null>(null)
  const [resolutionMode, setResolutionMode] = useState('adaptive')

  const resizeDesktop = (session: Session, width: number, height: number): void => {
    const physicalWidth = Math.max(1, Math.round((width * 25.4) / 96))
    const physicalHeight = Math.max(1, Math.round((height * 25.4) / 96))
    const canvas = canvasRef.current
    if (canvas) {
      canvas.width = width
      canvas.height = height
    }
    session.resize(width, height, 100, physicalWidth, physicalHeight)
    setDesktopSize({ width, height })
  }

  useEffect(() => {
    const canvas = canvasRef.current
    const viewport = viewportRef.current
    if (!canvas || !viewport || !remoteSession.viewerUrl || !remoteSession.viewerDestination)
      return undefined
    const viewerUrl = remoteSession.viewerUrl
    const viewerDestination = remoteSession.viewerDestination
    let disposed = false
    let currentStage: RdpStage = 'credential'
    onStatusChange?.('connecting')

    void (async () => {
      currentStage = 'credential'
      setStage('credential')
      credentialPromiseRef.current ??= useRemoteStore
        .getState()
        .claimViewerCredential(remoteSession.id)
      const credential = await credentialPromiseRef.current
      if (!credential?.username || !credential.password) {
        throw new Error('RDP username and password are required')
      }
      currentStage = 'engine'
      setStage(currentStage)
      await initIronRdp({ module_or_path: ironRdpWasmUrl })
      setup('warn')
      if (disposed) return
      const viewportBounds = viewport.getBoundingClientRect()
      const width = Math.max(640, Math.round(viewportBounds.width || 1280))
      const height = Math.max(480, Math.round(viewportBounds.height || 720))
      const builder = new SessionBuilder()
      builder.username(credential.username)
      builder.password(credential.password)
      if (credential.domain) builder.serverDomain(credential.domain)
      builder.destination(viewerDestination)
      builder.proxyAddress(viewerUrl)
      builder.authToken('ola-local')
      builder.desktopSize(new DesktopSize(width, height))
      builder.renderCanvas(canvas)
      builder.extension(new Extension('enable_credssp', true))
      builder.extension(new Extension('display_control', true))
      builder.setCursorStyleCallbackContext(canvas)
      builder.setCursorStyleCallback((style: string) => {
        canvas.style.cursor = style || 'default'
      })
      currentStage = 'bridge'
      setStage(currentStage)
      currentStage = 'authentication'
      setStage(currentStage)
      const rdpSession = await builder.connect()
      if (disposed) {
        rdpSession.shutdown()
        return
      }
      sessionRef.current = rdpSession
      const size = rdpSession.desktopSize()
      canvas.width = size.width
      canvas.height = size.height
      setDesktopSize({ width: size.width, height: size.height })
      currentStage = 'desktop'
      setStage(currentStage)
      setStatus('connected')
      onStatusChange?.('connected')
      canvas.focus()
      let resizeTimer: ReturnType<typeof setTimeout> | null = null
      let lastWidth = size.width
      let lastHeight = size.height
      const resizeObserver = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
          if (disposed || sessionRef.current !== rdpSession) return
          const bounds = viewport.getBoundingClientRect()
          if (bounds.width < 320 || bounds.height < 240) return
          const nextWidth = Math.max(640, Math.round(bounds.width / 2) * 2)
          const nextHeight = Math.max(480, Math.round(bounds.height / 2) * 2)
          if (Math.abs(nextWidth - lastWidth) < 4 && Math.abs(nextHeight - lastHeight) < 4) return
          lastWidth = nextWidth
          lastHeight = nextHeight
          if (resolutionModeRef.current !== 'adaptive') return
          resizeDesktop(rdpSession, nextWidth, nextHeight)
        }, 180)
      })
      resizeObserver.observe(viewport)
      void rdpSession
        .run()
        .then(() => {
          if (!disposed) {
            setStatus('disconnected')
            onStatusChange?.('disconnected')
          }
        })
        .catch((reason) => {
          if (!disposed) {
            const failure = classifyRdpFailure(reason, 'desktop', t)
            console.error('[IronRDP] Desktop session failed', reason)
            setStatus('error')
            onStatusChange?.('error')
            setErrorTitle(failure.title)
            setError(failure.message)
            setErrorDetail(failure.detail)
          }
        })
        .finally(() => {
          resizeObserver.disconnect()
          if (resizeTimer) clearTimeout(resizeTimer)
        })
    })().catch((reason) => {
      if (!disposed) {
        const failure = classifyRdpFailure(reason, currentStage, t)
        console.error(`[IronRDP] ${currentStage} stage failed`, reason)
        setStatus('error')
        onStatusChange?.('error')
        setErrorTitle(failure.title)
        setError(failure.message)
        setErrorDetail(failure.detail)
      }
    })

    return () => {
      disposed = true
      try {
        sessionRef.current?.releaseAllInputs()
        sessionRef.current?.shutdown()
      } catch {
        // The local bridge cleanup remains authoritative during teardown.
      }
      sessionRef.current = null
    }
  }, [
    onStatusChange,
    remoteSession.id,
    remoteSession.viewerDestination,
    remoteSession.viewerUrl,
    t
  ])

  const withSession = (callback: (session: Session) => void): void => {
    const session = sessionRef.current
    if (session) callback(session)
  }

  return (
    <div className="relative flex h-full min-h-[520px] flex-col overflow-hidden bg-black">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-xs text-white/70">
        <span>{remoteSession.viewerDestination}</span>
        <span className="flex items-center gap-3">
          <select
            value={resolutionMode}
            onChange={(event) => {
              const mode = event.target.value
              resolutionModeRef.current = mode
              setResolutionMode(mode)
              const session = sessionRef.current
              if (!session) return
              if (mode === 'adaptive') {
                const bounds = viewportRef.current?.getBoundingClientRect()
                if (bounds && bounds.width >= 320 && bounds.height >= 240) {
                  resizeDesktop(
                    session,
                    Math.max(640, Math.round(bounds.width / 2) * 2),
                    Math.max(480, Math.round(bounds.height / 2) * 2)
                  )
                }
                return
              }
              const option = RESOLUTION_OPTIONS.find((item) => item.value === mode)
              if (option && option.width > 0) resizeDesktop(session, option.width, option.height)
            }}
            className="rounded border border-white/15 bg-white/10 px-2 py-1 text-[11px] text-white outline-none"
            aria-label={t('remote.resolution')}
          >
            {RESOLUTION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value} className="bg-zinc-900">
                {option.value === 'adaptive'
                  ? t('remote.resolutionAdaptive')
                  : `${option.width} × ${option.height}`}
              </option>
            ))}
          </select>
          {desktopSize ? (
            <span className="font-mono text-white/45">
              {desktopSize.width} × {desktopSize.height}
            </span>
          ) : null}
          <span>
            {status === 'connecting'
              ? t('remote.rdpConnectingStage', { stage: t(`remote.rdpStage.${stage}`) })
              : t(`remote.status${status.charAt(0).toUpperCase()}${status.slice(1)}`)}
          </span>
        </span>
      </div>
      {error ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950 px-8 text-white">
          <div className="w-full max-w-lg">
            <div className="text-xs font-medium uppercase tracking-widest text-red-400">
              {t('remote.connectionFailed')}
            </div>
            <h3 className="mt-3 text-xl font-semibold">{errorTitle}</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-300">{error}</p>
            {errorDetail ? (
              <details className="mt-5 rounded-lg border border-white/10 bg-white/5 px-4 py-3">
                <summary className="cursor-pointer text-xs text-zinc-300">
                  {t('remote.technicalDetails')}
                </summary>
                <pre className="mt-3 whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-zinc-400">
                  {errorDetail}
                </pre>
              </details>
            ) : null}
          </div>
        </div>
      ) : null}
      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          className="block h-full w-full bg-black object-contain outline-none"
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            event.preventDefault()
            const scancode = SCANCODES[event.code]
            if (scancode != null)
              withSession((session) => applyEvent(session, DeviceEvent.keyPressed(scancode)))
          }}
          onKeyUp={(event) => {
            event.preventDefault()
            const scancode = SCANCODES[event.code]
            if (scancode != null)
              withSession((session) => applyEvent(session, DeviceEvent.keyReleased(scancode)))
          }}
          onPointerMove={(event) => {
            const canvas = canvasRef.current
            if (!canvas) return
            const bounds = canvas.getBoundingClientRect()
            const x = Math.round(((event.clientX - bounds.left) / bounds.width) * canvas.width)
            const y = Math.round(((event.clientY - bounds.top) / bounds.height) * canvas.height)
            withSession((session) => applyEvent(session, DeviceEvent.mouseMove(x, y)))
          }}
          onPointerDown={(event) => {
            event.preventDefault()
            event.currentTarget.focus()
            withSession((session) =>
              applyEvent(session, DeviceEvent.mouseButtonPressed(event.button))
            )
          }}
          onPointerUp={(event) => {
            event.preventDefault()
            withSession((session) =>
              applyEvent(session, DeviceEvent.mouseButtonReleased(event.button))
            )
          }}
          onWheel={(event) => {
            event.preventDefault()
            if (event.deltaY !== 0) {
              withSession((session) =>
                applyEvent(
                  session,
                  DeviceEvent.wheelRotations(true, event.deltaY > 0 ? -1 : 1, RotationUnit.Line)
                )
              )
            }
          }}
        />
      </div>
    </div>
  )
}
