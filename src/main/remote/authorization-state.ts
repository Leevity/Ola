import type { RemoteAccessMode } from '../../shared/remote-control'

/**
 * Whether this process may accept remote control right now, and which inbound
 * session is allowed to drive input. The mode is the durable permission from
 * the control plane; the session id is granted per connection.
 *
 * `unattended` keeps accepting input without anybody at the machine, which is
 * why the mode is only ever set from an authenticated control-plane response
 * and can be dropped to `none` instantly (see `setRemoteAccessMode`).
 */
let accessMode: RemoteAccessMode = 'none'
let activeInputSessionId: string | null = null
const revokeListeners = new Set<() => void>()

export function currentRemoteAccessMode(): RemoteAccessMode {
  return accessMode
}

export function isRemoteControlAllowed(): boolean {
  return accessMode !== 'none'
}

/** Applies a new mode, revoking any live session when access is withdrawn. */
export function setRemoteAccessMode(mode: RemoteAccessMode): void {
  const revoked = mode === 'none' && accessMode !== 'none'
  accessMode = mode
  if (mode === 'none') {
    const hadSession = activeInputSessionId !== null
    activeInputSessionId = null
    if (hadSession || revoked) {
      for (const listener of revokeListeners) listener()
    }
  }
}

/** Backwards-compatible boolean wrapper: pairing means attended access. */
export function setRemoteControlAllowed(allowed: boolean): void {
  setRemoteAccessMode(allowed ? 'attended' : 'none')
}

export function setAuthorizedInputSession(sessionId: string | null): void {
  if (sessionId && accessMode === 'none') {
    throw new Error('Remote control is not allowed for this process')
  }
  activeInputSessionId = sessionId
}

export function isInputSessionAuthorized(sessionId: string): boolean {
  return accessMode !== 'none' && activeInputSessionId === sessionId
}

export function subscribeRemoteControlRevoked(listener: () => void): () => void {
  revokeListeners.add(listener)
  return () => revokeListeners.delete(listener)
}
