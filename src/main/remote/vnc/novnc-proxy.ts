import type { RemoteConnection } from '../../../shared/remote-control'
import { createLanTcpWebSocketBridge, type LanBridge } from '../lan-tcp-websocket-bridge'

export async function launchNoVncProxy(connection: RemoteConnection): Promise<LanBridge> {
  if (connection.kind !== 'vnc' || !connection.host) throw new Error('Invalid noVNC connection')
  return createLanTcpWebSocketBridge(connection.host, connection.port ?? 5900)
}
