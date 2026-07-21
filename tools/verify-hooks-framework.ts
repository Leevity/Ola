import assert from 'node:assert/strict'
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { loadHooksConfig, parseHooksConfig } from '../src/main/hooks/hooks-loader'
import { HooksRunner } from '../src/main/hooks/hooks-runner'

const root = await mkdtemp(join(tmpdir(), 'ola-hooks-'))
const configDir = join(root, 'project', '.ola')
await mkdir(configDir, { recursive: true })
const scriptPath = join(configDir, 'hook.sh')
await writeFile(
  scriptPath,
  '#!/bin/sh\ncat >/dev/null\nprintf \'{"additionalContext":"ok","ignored":true}\'\n'
)
await chmod(scriptPath, 0o700)
const configPath = join(configDir, 'hooks.json')
await writeFile(
  configPath,
  JSON.stringify({
    version: 1,
    hooks: [{ id: 'context', event: 'sessionStart', command: './hook.sh' }]
  })
)

assert.throws(() => parseHooksConfig({ version: 2, hooks: [] }), /schema version/)
assert.throws(
  () => parseHooksConfig({ version: 1, hooks: [{ id: '../bad', event: 'stop', command: 'x' }] }),
  /invalid id/
)

const pending = await loadHooksConfig(configPath, 'project')
assert.equal(pending[0].trustState, 'pending')
const trusted = await loadHooksConfig(configPath, 'project', new Set([pending[0].trustKey]))
assert.equal(trusted[0].trustState, 'trusted')

await writeFile(
  scriptPath,
  '#!/bin/sh\ncat >/dev/null\nprintf \'{"additionalContext":"changed"}\'\n'
)
const changed = await loadHooksConfig(configPath, 'project', new Set([pending[0].trustKey]))
assert.equal(changed[0].trustState, 'pending', 'script changes must invalidate trust')

const outside = join(root, 'outside.sh')
await writeFile(outside, '#!/bin/sh\nexit 0\n')
await chmod(outside, 0o700)
await symlink(outside, join(configDir, 'linked.sh'))
await writeFile(
  configPath,
  JSON.stringify({ version: 1, hooks: [{ id: 'escape', event: 'stop', command: './linked.sh' }] })
)
await assert.rejects(loadHooksConfig(configPath, 'project'), /escapes/)

await writeFile(
  configPath,
  JSON.stringify({
    version: 1,
    hooks: [{ id: 'context', event: 'sessionStart', command: './hook.sh' }]
  })
)
const runnable = (await loadHooksConfig(configPath, 'project'))[0]
runnable.trustState = 'trusted'
const runner = new HooksRunner(1)
const success = await runner.run(runnable, { version: 1, event: 'sessionStart', sessionId: 's' })
assert.equal(success.output.additionalContext, 'changed')
assert.equal('ignored' in success.output, false)

const slowPath = join(configDir, 'slow.sh')
await writeFile(slowPath, '#!/bin/sh\nsleep 3\n')
await chmod(slowPath, 0o700)
await writeFile(
  configPath,
  JSON.stringify({
    version: 1,
    hooks: [{ id: 'slow', event: 'stop', command: './slow.sh', timeoutMs: 100 }]
  })
)
const slow = (await loadHooksConfig(configPath, 'project'))[0]
slow.trustState = 'trusted'
const timed = await runner.run(slow, { version: 1, event: 'stop', sessionId: 'slow' })
assert.equal(timed.record.status, 'timed-out')

const failingPath = join(configDir, 'failing.sh')
await writeFile(failingPath, '#!/bin/sh\nprintf failure >&2\nexit 7\n')
await chmod(failingPath, 0o700)
await writeFile(
  configPath,
  JSON.stringify({ version: 1, hooks: [{ id: 'failing', event: 'stop', command: './failing.sh' }] })
)
const failing = (await loadHooksConfig(configPath, 'project'))[0]
failing.trustState = 'trusted'
const failed = await runner.run(failing, { version: 1, event: 'stop', sessionId: 'failed' })
assert.equal(failed.record.status, 'failed')
assert.match(failed.record.stderrSummary, /failure/)

const floodPath = join(configDir, 'flood.sh')
await writeFile(floodPath, '#!/bin/sh\nyes x | head -c 300000\n')
await chmod(floodPath, 0o700)
await writeFile(
  configPath,
  JSON.stringify({ version: 1, hooks: [{ id: 'flood', event: 'stop', command: './flood.sh' }] })
)
const flood = (await loadHooksConfig(configPath, 'project'))[0]
flood.trustState = 'trusted'
const flooded = await runner.run(flood, { version: 1, event: 'stop', sessionId: 'flood' })
assert.equal(flooded.record.status, 'failed')

const concurrentRunner = new HooksRunner(1)
slow.timeoutMs = 5_000
const activeRun = concurrentRunner.run(slow, {
  version: 1,
  event: 'stop',
  sessionId: 'active',
  cancellationKey: 'active'
})
await assert.rejects(
  concurrentRunner.run(slow, { version: 1, event: 'stop', sessionId: 'second' }),
  /concurrency/
)
concurrentRunner.cancel('active')
assert.equal((await activeRun).record.status, 'canceled')

console.log('hooks framework verification passed')
