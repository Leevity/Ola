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
    socket.once('connect', () =>
      finish({
        success: true,
        host: normalizedHost,
        port,
        latencyMs: Date.now() - startedAt,
        category: 'reachable',
        message: 'TCP endpoint is reachable'
      })
    )
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
