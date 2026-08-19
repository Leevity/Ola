import { randomBytes } from 'crypto'
import { createConnection, type Socket } from 'net'
import { WebSocket, WebSocketServer, type RawData } from 'ws'

export type LanBridge = {
  viewerUrl: string
  close: () => void
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.alloc(0)
}

export async function createLanTcpWebSocketBridge(host: string, port: number): Promise<LanBridge> {
  const token = randomBytes(24).toString('hex')
  const path = `/remote/${token}`
  // RFB Tight/ZRLE payloads are already compressed. Adding WebSocket deflate
  // makes Electron spend CPU compressing/decompressing the same pixels again,
  // which increases latency and causes visible frame pacing jitter.
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    perMessageDeflate: false
  })
  const sockets = new Set<Socket>()
  const clients = new Set<WebSocket>()

  server.on('connection', (client, request) => {
    if (request.url !== path || clients.size > 0) {
      client.close(1008, 'Invalid or already-used remote bridge')
      return
    }
    clients.add(client)
    const socket = createConnection({ host, port })
    socket.setTimeout(8_000)
    sockets.add(socket)
    const pending: Buffer[] = []
    const pendingToClient: Buffer[] = []
    let pendingBytes = 0
    let pendingToClientBytes = 0
    let serverHandshake = Buffer.alloc(0)
    let serverBannerForwarded = false
    let securityListReordered = false

    const queueToClient = (data: Buffer): void => {
      if (data.length === 0) return
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: true })
      else {
        pendingToClientBytes += data.length
        pendingToClient.push(data)
      }
    }

    const forwardServerData = (data: Buffer): void => {
      if (securityListReordered) {
        queueToClient(data)
        return
      }

      serverHandshake = Buffer.concat([serverHandshake, data])
      if (!serverBannerForwarded) {
        if (serverHandshake.length < 12) return
        const banner = serverHandshake.subarray(0, 12)
        if (banner.subarray(0, 4).toString('ascii') !== 'RFB ') {
          serverBannerForwarded = true
          securityListReordered = true
          queueToClient(serverHandshake)
          serverHandshake = Buffer.alloc(0)
          return
        }
        serverBannerForwarded = true
        queueToClient(banner)
        serverHandshake = serverHandshake.subarray(12)
      }

      // The client must receive the banner before it can send its protocol
      // version. Only the following security list is held for reordering.
      if (serverHandshake.length < 1) return
      const count = serverHandshake[0]
      const securityEnd = 1 + count
      if (serverHandshake.length < securityEnd) return

      const securityTypes = serverHandshake.subarray(1, securityEnd)
      const preferredIndex = securityTypes.indexOf(2)
      const orderedTypes =
        preferredIndex > 0
          ? Buffer.concat([
              Buffer.from([2]),
              securityTypes.subarray(0, preferredIndex),
              securityTypes.subarray(preferredIndex + 1)
            ])
          : securityTypes
      const initial = Buffer.concat([Buffer.from([count]), orderedTypes])
      const remainder = serverHandshake.subarray(securityEnd)
      serverHandshake = Buffer.alloc(0)
      securityListReordered = true
      queueToClient(initial)
      queueToClient(remainder)
    }

    const flushToClient = (): void => {
      if (client.readyState !== WebSocket.OPEN) return
      for (const payload of pendingToClient.splice(0)) client.send(payload, { binary: true })
      pendingToClientBytes = 0
    }

    const flushBufferedSecurityList = (): void => {
      if (!serverBannerForwarded || securityListReordered || serverHandshake.length === 0) return
      forwardServerData(Buffer.alloc(0))
    }

    client.on('message', (data, isBinary) => {
      if (!isBinary) {
        client.close(1003, 'Binary frames are required')
        return
      }
      const payload = rawDataToBuffer(data)
      if (socket.connecting) {
        pendingBytes += payload.length
        if (pendingBytes > 1024 * 1024) {
          client.close(1009, 'Remote bridge queue exceeded')
          socket.destroy()
          return
        }
        pending.push(payload)
      } else if (!socket.destroyed) {
        socket.write(payload)
        // Mac Screen Sharing may send the banner and security list in one TCP
        // packet. The list can only be released after the client sends its
        // protocol version, so resume processing after forwarding this frame.
        flushBufferedSecurityList()
      }
    })
    socket.on('connect', () => {
      // The timeout only protects the initial TCP connection. A VNC session can
      // legitimately stay idle while the viewer remains open.
      socket.setTimeout(0)
      for (const payload of pending.splice(0)) socket.write(payload)
      pendingBytes = 0
      flushBufferedSecurityList()
    })
    socket.on('data', (data) => {
      forwardServerData(data)
      if (pendingToClientBytes > 1024 * 1024) {
        client.close(1009, 'Remote bridge response queue exceeded')
        socket.destroy()
        return
      }
      flushToClient()
    })
    client.on('open', flushToClient)
    socket.on('timeout', () => client.close(1011, 'Remote host connection timed out'))
    socket.on('error', () => client.close(1011, 'Remote host connection failed'))
    socket.on('close', () => {
      sockets.delete(socket)
      if (client.readyState === WebSocket.OPEN) client.close(1000, 'Remote host closed')
    })
    client.on('close', () => {
      clients.delete(client)
      sockets.delete(socket)
      socket.destroy()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Failed to start the built-in remote bridge')
  }

  return {
    viewerUrl: `ws://127.0.0.1:${address.port}${path}`,
    close: () => {
      for (const client of clients) client.close(1001, 'Ola session closed')
      for (const socket of sockets) socket.destroy()
      clients.clear()
      sockets.clear()
      server.close()
    }
  }
}
