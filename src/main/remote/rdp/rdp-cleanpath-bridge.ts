import { randomBytes } from 'crypto'
import { createConnection, isIP, type Socket } from 'net'
import { connect as connectTls, type DetailedPeerCertificate, type TLSSocket } from 'tls'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { LanBridge } from '../lan-tcp-websocket-bridge'

const CLEANPATH_VERSION = 3390
const TAG_SEQUENCE = 0x30
const TAG_INTEGER = 0x02
const TAG_OCTET_STRING = 0x04
const TAG_UTF8_STRING = 0x0c

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function wrap(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content])
}

function encodeInteger(value: number): Buffer {
  const bytes: number[] = []
  for (let current = value; current > 0; current >>>= 8) bytes.unshift(current & 0xff)
  if (bytes.length === 0) bytes.push(0)
  if ((bytes[0] & 0x80) !== 0) bytes.unshift(0)
  return wrap(TAG_INTEGER, Buffer.from(bytes))
}

function context(tag: number, content: Buffer): Buffer {
  return wrap(0xa0 + tag, content)
}

function decodeLength(buffer: Buffer, offset: number): { length: number; bytes: number } {
  if (offset >= buffer.length) throw new Error('Invalid RDCleanPath length')
  const first = buffer[offset]
  if (first < 0x80) return { length: first, bytes: 1 }
  const count = first & 0x7f
  if (count === 0 || count > 4 || offset + count >= buffer.length) {
    throw new Error('Invalid RDCleanPath length')
  }
  let length = 0
  for (let index = 0; index < count; index += 1) length = (length << 8) | buffer[offset + 1 + index]
  return { length, bytes: count + 1 }
}

function decodeTlv(buffer: Buffer, offset: number): { tag: number; value: Buffer; bytes: number } {
  if (offset >= buffer.length) throw new Error('Invalid RDCleanPath data')
  const decoded = decodeLength(buffer, offset + 1)
  const start = offset + 1 + decoded.bytes
  const end = start + decoded.length
  if (end > buffer.length) throw new Error('Truncated RDCleanPath data')
  return { tag: buffer[offset], value: buffer.subarray(start, end), bytes: end - offset }
}

function children(buffer: Buffer): Array<{ tag: number; value: Buffer }> {
  const result: Array<{ tag: number; value: Buffer }> = []
  for (let offset = 0; offset < buffer.length; ) {
    const child = decodeTlv(buffer, offset)
    result.push(child)
    offset += child.bytes
  }
  return result
}

function decodeInteger(buffer: Buffer): number {
  let value = 0
  for (const byte of buffer) value = (value << 8) | byte
  return value
}

function parseRequest(payload: Buffer): { destination: string; x224: Buffer } {
  if (payload.length === 0 || payload.length > 64 * 1024)
    throw new Error('Invalid RDCleanPath request')
  const root = decodeTlv(payload, 0)
  if (root.tag !== TAG_SEQUENCE || root.bytes !== payload.length) {
    throw new Error('Invalid RDCleanPath request')
  }
  let version = 0
  let destination = ''
  let x224: Buffer | null = null
  for (const field of children(root.value)) {
    const inner = decodeTlv(field.value, 0)
    if (field.tag === 0xa0) version = decodeInteger(inner.value)
    if (field.tag === 0xa2 && inner.tag === TAG_UTF8_STRING)
      destination = inner.value.toString('utf8')
    if (field.tag === 0xa6 && inner.tag === TAG_OCTET_STRING) x224 = Buffer.from(inner.value)
  }
  if (version !== CLEANPATH_VERSION || !destination || !x224) {
    throw new Error('Unsupported RDCleanPath request')
  }
  return { destination, x224 }
}

function buildResponse(serverAddress: string, x224: Buffer, certificates: Buffer[]): Buffer {
  const certificateSequence = wrap(
    TAG_SEQUENCE,
    Buffer.concat(certificates.map((certificate) => wrap(TAG_OCTET_STRING, certificate)))
  )
  return wrap(
    TAG_SEQUENCE,
    Buffer.concat([
      context(0, encodeInteger(CLEANPATH_VERSION)),
      context(6, wrap(TAG_OCTET_STRING, x224)),
      context(7, certificateSequence),
      context(9, wrap(TAG_UTF8_STRING, Buffer.from(serverAddress, 'utf8')))
    ])
  )
}

function buildError(): Buffer {
  const detail = wrap(TAG_SEQUENCE, context(0, encodeInteger(1)))
  return wrap(
    TAG_SEQUENCE,
    Buffer.concat([context(0, encodeInteger(CLEANPATH_VERSION)), context(1, detail)])
  )
}

function certificateChain(certificate: DetailedPeerCertificate): Buffer[] {
  const result: Buffer[] = []
  const seen = new Set<string>()
  let current: DetailedPeerCertificate | undefined = certificate
  while (current?.raw) {
    const fingerprint = current.fingerprint256 || current.raw.toString('hex')
    if (seen.has(fingerprint)) break
    seen.add(fingerprint)
    result.push(Buffer.from(current.raw))
    current = current.issuerCertificate === current ? undefined : current.issuerCertificate
  }
  return result
}

async function connectSocket(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    socket.setTimeout(15_000)
    socket.once('connect', () => {
      socket.setTimeout(0)
      resolve(socket)
    })
    socket.once('error', reject)
    socket.once('timeout', () => {
      socket.destroy()
      reject(new Error('RDP connection timed out'))
    })
  })
}

async function exchangeX224(socket: Socket, request: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk])
      const expected = received.length >= 4 ? received.readUInt16BE(2) : 0
      if (expected > 64 * 1024) {
        cleanup()
        reject(new Error('RDP negotiation response is too large'))
      } else if (expected >= 4 && received.length >= expected) {
        cleanup()
        resolve(received.subarray(0, expected))
      }
    }
    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('RDP server closed during negotiation'))
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    socket.write(request)
  })
}

async function upgradeTls(socket: Socket, host: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = connectTls({
      socket,
      servername: isIP(host) ? undefined : host,
      rejectUnauthorized: false,
      // Some Windows RDP hosts use a machine certificate that only permits RSA key
      // encipherment. Electron's default ECDHE preference then fails in BoringSSL with
      // KEY_USAGE_BIT_INCORRECT before certificate verification can be relaxed. RDP's
      // TLS transport is capped at TLS 1.2, and an RSA suite keeps those hosts usable.
      maxVersion: 'TLSv1.2',
      ciphers:
        'AES256-GCM-SHA384:AES128-GCM-SHA256:AES256-SHA256:AES128-SHA256:AES256-SHA:AES128-SHA'
    })
    tlsSocket.once('secureConnect', () => resolve(tlsSocket))
    tlsSocket.once('error', reject)
  })
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.alloc(0)
}

export async function createRdpCleanPathBridge(host: string, port: number): Promise<LanBridge> {
  const token = randomBytes(24).toString('hex')
  const path = `/remote/rdp/${token}`
  const expectedDestination = `${host}:${port}`
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
  const clients = new Set<WebSocket>()
  const sockets = new Set<Socket>()

  server.on('connection', (client, request) => {
    if (request.url !== path || clients.size > 0) {
      client.close(1008, 'Invalid or already-used RDP bridge')
      return
    }
    clients.add(client)
    client.once('message', (raw, isBinary) => {
      void (async () => {
        if (!isBinary) throw new Error('Binary RDCleanPath request required')
        const requestData = parseRequest(toBuffer(raw))
        if (requestData.destination !== expectedDestination) {
          throw new Error('RDP bridge destination does not match the Ola connection')
        }
        const socket = await connectSocket(host, port)
        sockets.add(socket)
        const x224 = await exchangeX224(socket, requestData.x224)
        const tlsSocket = await upgradeTls(socket, host)
        sockets.delete(socket)
        sockets.add(tlsSocket)
        const certificates = certificateChain(tlsSocket.getPeerCertificate(true))
        if (certificates.length === 0) throw new Error('RDP server certificate is unavailable')
        client.send(buildResponse(expectedDestination, x224, certificates), { binary: true })

        client.on('message', (payload, binary) => {
          if (!binary) return client.close(1003, 'Binary RDP frames required')
          if (!tlsSocket.destroyed) tlsSocket.write(toBuffer(payload))
        })
        tlsSocket.on('data', (payload) => {
          if (client.readyState === WebSocket.OPEN) client.send(payload, { binary: true })
        })
        tlsSocket.on('close', () => {
          sockets.delete(tlsSocket)
          if (client.readyState === WebSocket.OPEN) client.close(1000, 'RDP server closed')
        })
        tlsSocket.on('error', () => client.close(1011, 'RDP transport failed'))
      })().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[RDP bridge] ${expectedDestination} negotiation failed: ${message}`)
        if (client.readyState === WebSocket.OPEN) client.send(buildError(), { binary: true })
        client.close(1011, 'RDP negotiation failed')
      })
    })
    client.on('close', () => {
      clients.delete(client)
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Failed to start the built-in RDP bridge')
  }
  return {
    viewerUrl: `ws://127.0.0.1:${address.port}${path}`,
    close: () => {
      for (const client of clients) client.close(1001, 'Ola RDP session closed')
      for (const socket of sockets) socket.destroy()
      clients.clear()
      sockets.clear()
      server.close()
    }
  }
}
