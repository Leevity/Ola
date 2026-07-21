import { randomUUID } from 'crypto'
import { getRemoteConnection, markRemoteConnectionConnected } from './connection-store'
import { createRdpCleanPathBridge } from './rdp/rdp-cleanpath-bridge'
import { RemoteSessionManager } from './session-manager'
import { launchNoVncProxy } from './vnc/novnc-proxy'
import type { RemoteSession, RemoteViewerCredential } from '../../shared/remote-control'
import {
  getCredentialEntryForInjection,
  getCredentialRef,
  touchCredential
} from '../credentials/secret-vault'

export class RemoteControlEngine {
  readonly sessions = new RemoteSessionManager()
  private readonly viewerCredentials = new Map<string, RemoteViewerCredential>()

  getViewerCredential(sessionId: string): RemoteViewerCredential | null {
    return this.viewerCredentials.get(sessionId) ?? null
  }

  async connect(connectionId: string): Promise<RemoteSession> {
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

    if (credential) {
      this.viewerCredentials.set(sessionId, {
        username: connection.username || credential.username,
        password: credential.password,
        domain: connection.rdp?.domain ?? null
      })
    }

    await markRemoteConnectionConnected(connection.id)
    if (connection.credentialRef) touchCredential(connection.credentialRef)

    return this.sessions.create(
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
      null,
      'close' in launchResult
        ? () => {
            launchResult.close()
            this.viewerCredentials.delete(sessionId)
          }
        : () => this.viewerCredentials.delete(sessionId)
    )
  }

  disconnect(sessionId: string): RemoteSession | null {
    return this.sessions.disconnect(sessionId)
  }
}

export const remoteControlEngine = new RemoteControlEngine()
