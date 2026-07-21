import { spawn, type ChildProcess } from 'child_process'
import type { RemoteConnection } from '../../../shared/remote-control'
import { detectVncClient } from './vnc-detector'

export type RemoteLaunchResult = {
  process: ChildProcess
  command: string
  args: string[]
}

function requireProtocolConnection(
  connection: RemoteConnection
): asserts connection is RemoteConnection & {
  host: string
} {
  if (!connection.host) throw new Error('Remote connection host is required')
}

function buildVncArgs(connection: RemoteConnection, command: string): string[] {
  requireProtocolConnection(connection)
  const port = connection.port ?? 5900
  if (command === 'remmina') {
    return [`vnc://${connection.host}:${port}`]
  }
  return [`${connection.host}::${port}`]
}

export async function launchVncExternal(connection: RemoteConnection): Promise<RemoteLaunchResult> {
  if (connection.kind !== 'vnc') throw new Error('Connection is not a VNC connection')
  const status = await detectVncClient()
  if (!status.available || !status.command || status.command === 'websockify') {
    throw new Error(status.installHint ?? 'No external VNC viewer is available')
  }
  if (connection.credentialRef) {
    throw new Error(
      'Automatic VNC password injection is disabled because the detected viewer has no portable secret-safe input channel. Enter the password in the viewer.'
    )
  }

  const command = status.command
  const args = buildVncArgs(connection, command)
  const proc = spawn(command, args, {
    detached: false,
    stdio: 'ignore'
  })
  return { process: proc, command, args }
}
