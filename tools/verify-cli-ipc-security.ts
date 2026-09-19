import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const cli = await readFile('cli/src/index.ts', 'utf8')
const endpoint = await readFile('sidecars/Ola.Native.Worker/Runtime/WorkerEndpoint.cs', 'utf8')
const server = await readFile('sidecars/Ola.Native.Worker/Runtime/LocalIpcWorkerServer.cs', 'utf8')

assert.match(cli, /randomBytes\(32\)\.toString\('hex'\)/)
assert.match(cli, /--ipc-token/)
assert.match(cli, /method: '__ola_handshake'/)
assert.match(cli, /mkdtempSync\(join\('\/tmp', 'ola-cli-'\)\)/)
assert.match(cli, /chmodSync\(runtimeDir, 0o700\)/)
assert.match(endpoint, /AuthenticationToken/)
assert.match(server, /AuthenticateClientAsync/)
assert.match(server, /CryptographicOperations\.FixedTimeEquals/)
assert.match(server, /PipeOptions\.Asynchronous \| PipeOptions\.CurrentUserOnly/)
assert.match(server, /ValidateUnixSocketEndpoint/)
assert.match(server, /refusing to delete IPC socket link/)
assert.match(server, /FileAttributes\.ReparsePoint/)

console.log('CLI IPC security verification passed')
