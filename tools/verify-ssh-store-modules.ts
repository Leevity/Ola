import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SSH_STORE_EVENT_CHANNELS } from '../src/renderer/src/stores/ssh/events'
import { selectSshConnections } from '../src/renderer/src/stores/ssh/connections'
import { selectSshTransfers } from '../src/renderer/src/stores/ssh/transfers'

const storeSource = readFileSync('src/renderer/src/stores/ssh-store.ts', 'utf8')
assert.match(storeSource, /export type \* from ['"]\.\.\/\.\.\/\.\.\/shared\/ssh-contract['"]/)
assert.doesNotMatch(storeSource, /export interface SshConnection \{/)
assert.equal(SSH_STORE_EVENT_CHANNELS.status, 'ssh:status')

const connections = [{ id: 'connection-1' }]
const transfers = { uploadTasks: {}, transferTasks: {} }
const state = { connections, ...transfers }
assert.equal(selectSshConnections(state as never), connections)
assert.deepEqual(selectSshTransfers(state as never), transfers)

console.log('SSH store module verification passed')
