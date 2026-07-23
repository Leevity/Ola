import { randomUUID } from 'crypto'
import { getRemoteConnection, markRemoteConnectionConnected } from './connection-store'
import { createRdpCleanPathBridge } from './rdp/rdp-cleanpath-bridge'
import { clearRemoteInputSession, clearRemoteInputSessionIfOwned } from './input-controller'
import { RemoteSessionManager } from './session-manager'
import { ViewerCredentialLeaseRegistry } from './viewer-credential-lease'
import { launchNoVncProxy } from './vnc/novnc-proxy'
import type {
  RemoteConnectResult,
  RemoteSession,
  RemoteViewerCredential
} from '../../shared/remote-control'
import {
  getCredentialEntryForInjection,
  getCredentialRef,
  touchCredential
} from '../credentials/secret-vault'

export class RemoteControlEngine {
  readonly sessions = new RemoteSessionManager()
  private readonly viewerCredentialLeases = new ViewerCredentialLeaseRegistry()

  claimViewerCredential(
    sessionId: string,
    ownerWebContentsId: number,
    lease: string
  ): RemoteViewerCredential | null {
    if (!this.sessions.isOwnedBy(sessionId, ownerWebContentsId)) return null
    return this.viewerCredentialLeases.claim(sessionId, ownerWebContentsId, lease)
  }

  listSessions(ownerWebContentsId: number): RemoteSession[] {
    return this.sessions.listByOwner(ownerWebContentsId)
  }

  async connect(connectionId: string, ownerWebContentsId: number): Promise<RemoteConnectResult> {
    const connection = await getRemoteConnection(connectionId)
    if (!connection) throw new Error('Remote connection not found')
    if (connection.kind !== 'rdp' && connection.kind !== 'vnc') {
      throw new Error(`Remote connection kind ${connection.kind} is not supported yet`)
    }

    if (connection.credentialRef && !getCredentialRef(connection.credentialRef)) {
      throw new Error('Remote credential is missing from Credential Vault')
    }
    const credential = connection.credentialRef
      ? getCredentialEntryForInjection(connection.credentialRef)
      : null
    if (connection.credentialRef && !credential) {
      throw new Error('Remote credential password is unavailable from Credential Vault')
    }

    const sessionId = randomUUID()
    const launchResult =
      connection.kind === 'rdp'
        ? await createRdpCleanPathBridge(connection.host as string, connection.port ?? 3389)
        : await launchNoVncProxy(connection)

    await markRemoteConnectionConnected(connection.id)
    if (connection.credentialRef) touchCredential(connection.credentialRef)

    const session = this.sessions.create(
      {
        id: sessionId,
        kind: connection.kind,
        connectionId: connection.id,
        status: 'connected',
        error: null,
        viewerUrl: 'viewerUrl' in launchResult ? launchResult.viewerUrl : null,
        viewerType: connection.kind,
        viewerDestination: `${connection.host}:${connection.port ?? (connection.kind === 'rdp' ? 3389 : 5900)}`,
        credentialAvailable: Boolean(credential)
      },
      ownerWebContentsId,
      null,
      'close' in launchResult
        ? () => {
            launchResult.close()
            this.viewerCredentialLeases.revokeSession(sessionId)
          }
        : () => this.viewerCredentialLeases.revokeSession(sessionId)
    )

    return {
      session,
      credentialLease: credential
        ? this.viewerCredentialLeases.issue(sessionId, ownerWebContentsId, {
            username: connection.username || credential.username,
            password: credential.password,
            domain: connection.rdp?.domain ?? null
          })
        : null
    }
  }

  disconnect(sessionId: string, ownerWebContentsId: number): RemoteSession | null {
    if (!this.sessions.isOwnedBy(sessionId, ownerWebContentsId)) return null
    clearRemoteInputSessionIfOwned(sessionId, ownerWebContentsId)
    return this.sessions.disconnect(sessionId)
  }

  disconnectOwnedBy(ownerWebContentsId: number): void {
    clearRemoteInputSession(ownerWebContentsId)
    this.sessions.disconnectByOwner(ownerWebContentsId)
  }
}

export const remoteControlEngine = new RemoteControlEngine()
