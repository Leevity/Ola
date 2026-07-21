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
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
  const sockets = new Set<Socket>()
  const clients = new Set<WebSocket>()

  server.on('connection', (client, request) => {
    if (request.url !== path || clients.size > 0) {
      client.close(1008, 'Invalid or already-used remote bridge')
      return
    }
    clients.add(client)
    const socket = createConnection({ host, port })
    sockets.add(socket)
    const pending: Buffer[] = []
    let pendingBytes = 0

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
      }
    })
    socket.on('connect', () => {
      for (const payload of pending.splice(0)) socket.write(payload)
      pendingBytes = 0
    })
    socket.on('data', (data) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: true })
    })
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
