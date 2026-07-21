import { spawn, type ChildProcess } from 'child_process'
import type { RemoteConnection } from '../../../shared/remote-control'
import { detectRdpClient } from './rdp-detector'

export type RemoteLaunchResult = {
  process: ChildProcess
  command: string
  args: string[]
}

export type RemoteLaunchCredential = { username: string; password: string }

function requireProtocolConnection(
  connection: RemoteConnection
): asserts connection is RemoteConnection & {
  host: string
} {
  if (!connection.host) throw new Error('Remote connection host is required')
}

function buildWindowsMstscArgs(connection: RemoteConnection): string[] {
  requireProtocolConnection(connection)
  const host = connection.port ? `${connection.host}:${connection.port}` : connection.host
  return [`/v:${host}`]
}

function buildFreeRdpArgs(
  connection: RemoteConnection,
  credential?: RemoteLaunchCredential | null
): string[] {
  requireProtocolConnection(connection)
  const args = [`/v:${connection.host}:${connection.port ?? 3389}`]
  const username = connection.username || credential?.username
  if (username) args.push(`/u:${username}`)
  if (credential) args.push('/from-stdin')
  if (connection.rdp?.domain) args.push(`/d:${connection.rdp.domain}`)
  args.push(`/bpp:${connection.rdp?.colorDepth ?? 32}`)
  args.push('+compression')
  if (connection.rdp?.clipboard !== false) args.push('+clipboard')
  if (connection.rdp?.width && connection.rdp?.height) {
    args.push(`/size:${connection.rdp.width}x${connection.rdp.height}`)
  } else {
    args.push('/dynamic-resolution')
  }
  return args
}

export async function launchRdpExternal(
  connection: RemoteConnection,
  credential?: RemoteLaunchCredential | null
): Promise<RemoteLaunchResult> {
  if (connection.kind !== 'rdp') throw new Error('Connection is not an RDP connection')
  const status = await detectRdpClient()
  if (!status.available || !status.command) {
    throw new Error(status.installHint ?? 'No RDP client is available')
  }

  const command = status.command
  if (process.platform === 'win32' && credential) {
    throw new Error(
      'Automatic password injection is unavailable for mstsc. Save the credential in Windows Credential Manager or remove it from this Ola connection.'
    )
  }
  const args =
    process.platform === 'win32'
      ? buildWindowsMstscArgs(connection)
      : buildFreeRdpArgs(connection, credential)
  const proc = spawn(command, args, {
    detached: false,
    stdio: credential ? ['pipe', 'ignore', 'ignore'] : 'ignore'
  })
  if (credential) {
    proc.stdin?.end(`${credential.password}\n`)
  }
  return { process: proc, command, args }
}
