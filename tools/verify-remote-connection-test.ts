import { createServer } from 'net'
import { testRemoteEndpoint } from '../src/main/remote/connection-tester.ts'

const server = createServer((socket) => socket.end())
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})

try {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server has no TCP address')
  const reachable = await testRemoteEndpoint('127.0.0.1', address.port)
  if (!reachable.success || reachable.category !== 'reachable' || reachable.latencyMs == null) {
    throw new Error(`Reachable endpoint was not detected: ${JSON.stringify(reachable)}`)
  }

  const invalid = await testRemoteEndpoint('', 0)
  if (invalid.success || invalid.category !== 'invalid') {
    throw new Error(`Invalid endpoint was not rejected: ${JSON.stringify(invalid)}`)
  }

  console.log(JSON.stringify({ reachable: true, invalidRejected: true }))
} finally {
  server.close()
}
