import { createConnection } from 'net'
import type { RemoteConnectionTestResult } from '../../shared/remote-control'

const TEST_TIMEOUT_MS = 5_000

function classifyError(code: string | undefined): RemoteConnectionTestResult['category'] {
  if (code === 'ETIMEDOUT') return 'timeout'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns'
  if (code === 'ECONNREFUSED') return 'refused'
  return 'network'
}

export function testRemoteEndpoint(
  host: string,
  port: number
): Promise<RemoteConnectionTestResult> {
  const normalizedHost = host.trim()
  if (
    !normalizedHost ||
    normalizedHost.length > 255 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return Promise.resolve({
      success: false,
      host: normalizedHost,
      port,
      latencyMs: null,
      category: 'invalid',
      message: 'Host or port is invalid'
    })
  }

  return new Promise((resolve) => {
    const startedAt = Date.now()
    const socket = createConnection({ host: normalizedHost, port })
    let settled = false
    const finish = (result: RemoteConnectionTestResult): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(TEST_TIMEOUT_MS)
    socket.once('connect', () => {
      // Send the VNC ProtocolVersion handshake so the test distinguishes "port
      // open" from "VNC actually answering". Mac Screen Sharing responds
      // with `RFB 003.008\n`; macOS without Screen Sharing enabled accepts
      // the TCP connection but stays silent, which we surface as a
      // distinct category.
      let protocol = ''
      const onData = (chunk: Buffer): void => {
        protocol += chunk.toString('ascii')
        if (protocol.length >= 12) {
          socket.off('data', onData)
          finish({
            success: true,
            host: normalizedHost,
            port,
            latencyMs: Date.now() - startedAt,
            category: 'reachable',
            message: protocol.startsWith('RFB ')
              ? `VNC server answered (${protocol.split('\n')[0].trim()})`
              : 'TCP endpoint is reachable (no VNC banner)'
          })
        }
      }
      socket.on('data', onData)
      socket.write('RFB 003.008\n')
      socket.setTimeout(TEST_TIMEOUT_MS)
    })
    socket.once('timeout', () =>
      finish({
        success: false,
        host: normalizedHost,
        port,
        latencyMs: null,
        category: 'timeout',
        message: `Connection timed out after ${TEST_TIMEOUT_MS}ms`
      })
    )
    socket.once('error', (error: NodeJS.ErrnoException) => {
      const category = classifyError(error.code)
      finish({
        success: false,
        host: normalizedHost,
        port,
        latencyMs: null,
        category,
        message: error.message
      })
    })
  })
}
