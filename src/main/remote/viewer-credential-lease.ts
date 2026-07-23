import { randomBytes } from 'crypto'
import type { RemoteViewerCredential } from '../../shared/remote-control'

type ViewerCredentialLease = {
  sessionId: string
  ownerWebContentsId: number
  credential: RemoteViewerCredential
  expiresAt: number
}

const DEFAULT_LEASE_TTL_MS = 30_000

export class ViewerCredentialLeaseRegistry {
  private readonly leases = new Map<string, ViewerCredentialLease>()

  issue(
    sessionId: string,
    ownerWebContentsId: number,
    credential: RemoteViewerCredential,
    ttlMs = DEFAULT_LEASE_TTL_MS
  ): string {
    this.revokeSession(sessionId)
    const lease = randomBytes(32).toString('base64url')
    this.leases.set(lease, {
      sessionId,
      ownerWebContentsId,
      credential,
      expiresAt: Date.now() + ttlMs
    })
    return lease
  }

  claim(
    sessionId: string,
    ownerWebContentsId: number,
    lease: string
  ): RemoteViewerCredential | null {
    const entry = this.leases.get(lease)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      this.leases.delete(lease)
      return null
    }
    if (entry.sessionId !== sessionId || entry.ownerWebContentsId !== ownerWebContentsId)
      return null
    this.leases.delete(lease)
    return entry.credential
  }

  revokeSession(sessionId: string): void {
    for (const [lease, entry] of this.leases) {
      if (entry.sessionId === sessionId) this.leases.delete(lease)
    }
  }
}
