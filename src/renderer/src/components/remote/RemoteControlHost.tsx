import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { useRemoteAccountStore } from '@renderer/stores/remote-account-store'
import { useRemoteCaptureStore } from '@renderer/stores/remote-capture-store'
import { useRemotePeerStore } from '@renderer/stores/remote-peer-store'
import { useRemoteSignalingStore } from '@renderer/stores/remote-signaling-store'
import { Button } from '@renderer/components/ui/button'
import type { RemoteAccessSnapshot } from '../../../../shared/remote-control'

const POLL_INTERVAL_MS = 8_000

/**
 * App-level host for inbound remote control.
 *
 * The desktop has to accept a control session even when the remote page is not
 * open — that is the whole point of unattended access: the console (or the
 * mobile app) connects to a machine where nobody is looking at Ola. So the
 * signalling socket and the incoming-offer listener live here, at the app root,
 * instead of inside the remote page.
 *
 * It also keeps unattended access honest. Unattended is the only mode where
 * nobody is watching, so it gets:
 *  - a persistent badge with a one-click revoke;
 *  - automatic screen sharing (there is nobody to click "share");
 *  - a visible count of how much autonomy has already been spent.
 */
export function RemoteControlHost(): React.JSX.Element | null {
  const { t } = useTranslation('layout')
  const [snapshot, setSnapshot] = useState<RemoteAccessSnapshot | null>(null)
  const [revoking, setRevoking] = useState(false)
  const account = useRemoteAccountStore((state) => state.account)
  // Only the id, not the device object: a heartbeat replaces the object every
  // 30 seconds, and re-running these effects would tear down and re-establish
  // the signalling socket in the middle of an inbound session.
  const deviceId = useRemoteAccountStore((state) => state.device?.id)
  const remoteAccessMode = useRemoteAccountStore((state) => state.remoteAccessMode)
  const setRemoteAccessMode = useRemoteAccountStore((state) => state.setRemoteAccessMode)
  const issueDeviceSignalToken = useRemoteAccountStore((state) => state.issueDeviceSignalToken)
  const connectSignaling = useRemoteSignalingStore((state) => state.connect)
  const listenForIncoming = useRemotePeerStore((state) => state.listenForIncoming)
  const captureStatus = useRemoteCaptureStore((state) => state.status)
  const startCapture = useRemoteCaptureStore((state) => state.startProbe)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = (await ipcClient.invoke(IPC.REMOTE_ACCESS_SNAPSHOT)) as RemoteAccessSnapshot
      setSnapshot(next)
    } catch {
      setSnapshot(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS)
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  // Keep the signalling socket up for as long as the app runs, so an inbound
  // session does not depend on which page happens to be open.
  useEffect(() => {
    if (!account || !deviceId) return undefined
    let active = true
    void issueDeviceSignalToken()
      .then((token) => {
        if (active) return connectSignaling(token)
        return undefined
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [account, deviceId, issueDeviceSignalToken, connectSignaling])

  // Incoming offers are ignored while access is off: the durable permission is
  // the gate, not the mere presence of a listening socket.
  useEffect(() => {
    if (!deviceId) return undefined
    return listenForIncoming(deviceId, remoteAccessMode !== 'none')
  }, [deviceId, remoteAccessMode, listenForIncoming])

  // Unattended access must keep the capture stream alive on its own: it is the
  // only thing the controller can actually see.
  useEffect(() => {
    if (remoteAccessMode !== 'unattended') return
    if (captureStatus === 'capturing' || captureStatus === 'requesting') return
    void startCapture().catch(() => undefined)
  }, [remoteAccessMode, captureStatus, startCapture])

  if (!snapshot || snapshot.mode === 'none') return null

  const unattended = snapshot.mode === 'unattended'
  const revoke = async (): Promise<void> => {
    setRevoking(true)
    try {
      // Local cut first: input is refused before the control plane answers.
      await ipcClient.invoke(IPC.REMOTE_ACCESS_REVOKE)
      await setRemoteAccessMode('none')
      await refresh()
    } catch {
      // Stay visible: a failed revoke must not look like a successful one.
    } finally {
      setRevoking(false)
    }
  }

  return (
    <div
      className={`pointer-events-auto fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-3 rounded-lg border px-3 py-2 shadow-lg ${
        unattended ? 'border-destructive/50 bg-destructive/10' : 'border-border bg-card'
      }`}
      role={unattended ? 'alert' : 'status'}
    >
      {unattended ? (
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      ) : (
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1 text-xs">
        <p className="font-medium">
          {t(unattended ? 'remote.bannerUnattended' : 'remote.bannerAttended')}
        </p>
        <p className="mt-0.5 text-muted-foreground">
          {unattended
            ? t('remote.bannerUnattendedDetail', {
                used: snapshot.autoApprovalsUsed,
                limit: snapshot.autoApprovalsLimit
              })
            : t('remote.bannerAttendedDetail')}
        </p>
      </div>
      <Button size="sm" variant="outline" disabled={revoking} onClick={() => void revoke()}>
        {t('remote.bannerRevoke')}
      </Button>
    </div>
  )
}
