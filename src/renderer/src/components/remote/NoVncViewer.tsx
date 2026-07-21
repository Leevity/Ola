import { useEffect, useRef, useState } from 'react'
import RFB from '@novnc/novnc'
import { useTranslation } from 'react-i18next'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import type { RemoteViewerCredential } from '@renderer/lib/remote/remote-types'

export function NoVncViewer({
  sessionId,
  viewerUrl,
  onStatusChange
}: {
  sessionId: string
  viewerUrl: string
  onStatusChange?: (status: 'connecting' | 'connected' | 'disconnected' | 'error') => void
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const targetRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>(
    'connecting'
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const target = targetRef.current
    if (!target) return undefined
    onStatusChange?.('connecting')
    const rfb = new RFB(target, viewerUrl, { shared: true })
    rfb.scaleViewport = true
    rfb.resizeSession = true
    rfb.background = '#000000'

    const connected = (): void => {
      setStatus('connected')
      onStatusChange?.('connected')
    }
    const disconnected = (): void => {
      setStatus('disconnected')
      onStatusChange?.('disconnected')
    }
    const failed = (): void => {
      setStatus('error')
      onStatusChange?.('error')
      setError(
        t('remote.noVncSecurityFailure', {
          defaultValue: 'The VNC server rejected the connection security handshake.'
        })
      )
    }
    const credentialsRequired = (): void => {
      void ipcClient
        .invoke(IPC.REMOTE_SESSION_CREDENTIAL, { sessionId })
        .then((value) => {
          const credential = value as RemoteViewerCredential | null
          if (!credential?.password) throw new Error('VNC credentials are unavailable')
          ;(
            rfb as unknown as {
              sendCredentials: (credentials: { username?: string; password: string }) => void
            }
          ).sendCredentials({
            username: credential.username || undefined,
            password: credential.password
          })
        })
        .catch(() => {
          setStatus('error')
          onStatusChange?.('error')
          setError(
            t('remote.noVncCredentialsRequired', {
              defaultValue: 'The VNC server requires a password. Reconnect and enter it again.'
            })
          )
          rfb.disconnect()
        })
    }
    rfb.addEventListener('connect', connected)
    rfb.addEventListener('disconnect', disconnected)
    rfb.addEventListener('securityfailure', failed)
    rfb.addEventListener('credentialsrequired', credentialsRequired)
    rfb.focus()

    return () => {
      rfb.removeEventListener('connect', connected)
      rfb.removeEventListener('disconnect', disconnected)
      rfb.removeEventListener('securityfailure', failed)
      rfb.removeEventListener('credentialsrequired', credentialsRequired)
      rfb.disconnect()
    }
  }, [onStatusChange, sessionId, t, viewerUrl])

  return (
    <div className="overflow-hidden rounded-2xl border bg-black shadow-sm">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-xs text-white/70">
        <span>{t('remote.embeddedNoVnc', { defaultValue: 'Embedded noVNC' })}</span>
        <span>
          {t(`remote.status${status.charAt(0).toUpperCase()}${status.slice(1)}`, {
            defaultValue: status
          })}
        </span>
      </div>
      {error ? (
        <div className="bg-destructive/15 px-4 py-3 text-xs text-red-200">{error}</div>
      ) : null}
      <div ref={targetRef} className="aspect-video min-h-80 w-full overflow-hidden" />
    </div>
  )
}
