import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = await mkdtemp(join(tmpdir(), 'ola-remote-store-'))
const configPath = join(directory, 'connections.json')
process.env.OLA_REMOTE_CONNECTIONS_PATH = configPath

try {
  const store = await import('../src/main/remote/connection-store.ts')
  const created = await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      store.createRemoteConnection({
        kind: index % 2 === 0 ? 'rdp' : 'vnc',
        name: `Concurrent ${index}`,
        host: `host-${index}.example.test`,
        port: index % 2 === 0 ? 3389 : 5900
      })
    )
  )
  assert.equal(new Set(created.map((item) => item.id)).size, 50)
  assert.equal((await store.listRemoteConnections()).connections.length, 50)

  await Promise.all(
    created.map((item, index) =>
      store.updateRemoteConnection({ id: item.id, patch: { name: `Updated ${index}` } })
    )
  )
  const updated = await store.listRemoteConnections()
  assert.equal(updated.connections.filter((item) => item.name.startsWith('Updated ')).length, 50)

  const persisted = JSON.parse(await readFile(configPath, 'utf8')) as { connections: unknown[] }
  assert.equal(persisted.connections.length, 50)

  await assert.rejects(
    store.createRemoteConnection({
      kind: 'rdp',
      name: 'Invalid',
      host: 'host',
      unexpected: true
    } as never),
    /Unknown remote connection field/
  )

  await writeFile(configPath, '{broken json', 'utf8')
  const recovered = await store.listRemoteConnections()
  assert.ok(recovered.connections.length >= 49)

  process.stdout.write(
    JSON.stringify({ concurrentCreates: 50, concurrentUpdates: 50, backupRecovery: true }) + '\n'
  )
} finally {
  delete process.env.OLA_REMOTE_CONNECTIONS_PATH
  await rm(directory, { recursive: true, force: true })
}
