import assert from 'node:assert/strict'
import { McpAutoConnectCoordinator } from '../src/main/mcp/autoconnect-coordinator.ts'
import type { McpServerConfig } from '../src/main/mcp/mcp-types.ts'

const config = (id: string): McpServerConfig => ({
  id,
  name: id,
  enabled: true,
  transport: 'stdio',
  command: 'echo',
  createdAt: 0
})

let now = 1_000
const sleepDurations: number[] = []
const coordinator = new McpAutoConnectCoordinator({
  maxConcurrency: 2,
  maxAttempts: 3,
  initialBackoffMs: 10,
  circuitOpenMs: 100,
  now: () => now,
  sleep: async (ms) => {
    sleepDurations.push(ms)
  }
})

let attempts = 0
const failed = await coordinator.connectEnabled([config('failing')], async () => {
  attempts += 1
  throw new Error('offline')
})
assert.deepEqual(failed, [
  { serverId: 'failing', status: 'failed', attempts: 3, error: 'offline', retryAt: 1_100 }
])
assert.equal(attempts, 3)
assert.deepEqual(sleepDurations, [10, 20])

const skipped = await coordinator.connectEnabled([config('failing')], async () => {
  throw new Error('must not run while circuit is open')
})
assert.deepEqual(skipped, [{ serverId: 'failing', status: 'circuit-open', retryAt: 1_100 }])

now = 1_101
let concurrent = 0
let peakConcurrency = 0
const connected = await coordinator.connectEnabled(
  [config('a'), config('b'), config('c')],
  async () => {
    concurrent += 1
    peakConcurrency = Math.max(peakConcurrency, concurrent)
    await Promise.resolve()
    concurrent -= 1
  }
)
assert.equal(connected.filter((result) => result.status === 'connected').length, 3)
assert.ok(peakConcurrency <= 2)

coordinator.reset('failing')
const recovered = await coordinator.connectEnabled([config('failing')], async () => undefined)
assert.deepEqual(recovered, [{ serverId: 'failing', status: 'connected', attempts: 1 }])

console.log('MCP auto-connect verification passed')
