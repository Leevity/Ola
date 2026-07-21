let remoteControlAllowed = false
let activeInputSessionId: string | null = null
const revokeListeners = new Set<() => void>()

export function isRemoteControlAllowed(): boolean {
  return remoteControlAllowed
}

export function setRemoteControlAllowed(allowed: boolean): void {
  remoteControlAllowed = allowed
  if (!allowed) {
    activeInputSessionId = null
    for (const listener of revokeListeners) listener()
  }
}

export function setAuthorizedInputSession(sessionId: string | null): void {
  if (sessionId && !remoteControlAllowed) {
    throw new Error('Remote control is not allowed for this process')
  }
  activeInputSessionId = sessionId
}

export function isInputSessionAuthorized(sessionId: string): boolean {
  return remoteControlAllowed && activeInputSessionId === sessionId
}

export function subscribeRemoteControlRevoked(listener: () => void): () => void {
  revokeListeners.add(listener)
  return () => revokeListeners.delete(listener)
}
