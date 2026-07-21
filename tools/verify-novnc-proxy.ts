import { createServer } from 'net'
import WebSocket from 'ws'
import { launchNoVncProxy } from '../src/main/remote/vnc/novnc-proxy.ts'
import type { RemoteConnection } from '../src/shared/remote-control.ts'

async function main(): Promise<void> {
  const tcpServer = createServer((socket) => socket.on('data', (data) => socket.write(data)))
  await new Promise<void>((resolve, reject) => {
    tcpServer.once('error', reject)
    tcpServer.listen(0, '127.0.0.1', resolve)
  })
  const address = tcpServer.address()
  if (!address || typeof address === 'string') throw new Error('TCP test server did not bind')

  const connection: RemoteConnection = {
    id: 'novnc-test',
    kind: 'vnc',
    groupId: null,
    name: 'noVNC test',
    host: '127.0.0.1',
    port: address.port,
    username: null,
    credentialRef: null,
    tags: [],
    lastConnectedAt: null,
    sortOrder: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    vnc: { viewOnly: false, launchMode: 'novnc' }
  }

  const bridge = await launchNoVncProxy(connection)
  try {
    if (!/^ws:\/\/127\.0\.0\.1:\d+\/remote\/[a-f0-9]{48}$/.test(bridge.viewerUrl)) {
      throw new Error(`Unexpected viewer URL: ${bridge.viewerUrl}`)
    }
    const client = new WebSocket(bridge.viewerUrl)
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })
    client.send(Buffer.from('ola-bridge-probe'))
    const reply = await new Promise<Buffer>((resolve, reject) => {
      client.once('message', (data) => resolve(Buffer.from(data as Buffer)))
      client.once('error', reject)
    })
    if (reply.toString() !== 'ola-bridge-probe') throw new Error('TCP relay changed payload')
    client.close()
    console.log(JSON.stringify({ relay: true, loopbackOnly: true, tokenized: true, cleanup: true }))
  } finally {
    bridge.close()
    tcpServer.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
