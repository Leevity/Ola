import assert from 'node:assert/strict'
import { copyFile, link, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadHooksConfig, parseHooksConfig } from '../src/main/hooks/hooks-loader'
import { HooksRunner } from '../src/main/hooks/hooks-runner'

const root = await mkdtemp(join(tmpdir(), 'ola-hooks-'))
const configDir = join(root, 'project', '.ola')
await mkdir(configDir, { recursive: true })
const configPath = join(configDir, 'hooks.json')
const hookConfig = (hooks: Array<Record<string, unknown>>): string =>
  JSON.stringify({ version: 1, hooks: hooks.map((hook) => ({ args: [], ...hook })) })

// Trust hashing covers the executed file, so the loader cases keep the hook file
// itself as the command. The runner spawns that command directly, and a
// `#!/bin/sh` script is not spawnable on Windows (EFTYPE); the execution cases
// therefore use a copy of the current Node binary plus a Node script argument.
const hookFilePath = join(configDir, 'hook.mjs')
await writeFile(
  hookFilePath,
  `process.stdout.write(JSON.stringify({additionalContext:'ok',ignored:true}));`
)

assert.throws(() => parseHooksConfig({ version: 2, hooks: [] }), /schema version/)
assert.throws(
  () => parseHooksConfig({ version: 1, hooks: [{ id: '../bad', event: 'stop', command: 'x' }] }),
  /invalid id/
)

await writeFile(
  configPath,
  hookConfig([{ id: 'context', event: 'sessionStart', command: './hook.mjs' }])
)
const pending = await loadHooksConfig(configPath, 'project')
assert.equal(pending[0].trustState, 'pending')
const trusted = await loadHooksConfig(configPath, 'project', new Set([pending[0].trustKey]))
assert.equal(trusted[0].trustState, 'trusted')

await writeFile(
  hookFilePath,
  `process.stdout.write(JSON.stringify({additionalContext:'changed'}));process.exit(0);`
)
const changed = await loadHooksConfig(configPath, 'project', new Set([pending[0].trustKey]))
assert.equal(changed[0].trustState, 'pending', 'script changes must invalidate trust')

const artifactPath = join(configDir, 'policy.txt')
await writeFile(artifactPath, 'v1')
await writeFile(
  configPath,
  hookConfig([
    {
      id: 'artifact',
      event: 'sessionStart',
      command: './hook.mjs',
      artifacts: ['./policy.txt']
    }
  ])
)
const artifactHook = (await loadHooksConfig(configPath, 'project'))[0]
await writeFile(artifactPath, 'v2')
const changedArtifact = await loadHooksConfig(
  configPath,
  'project',
  new Set([artifactHook.trustKey])
)
assert.equal(changedArtifact[0].trustState, 'pending', 'artifact changes must invalidate trust')

const outside = join(root, 'outside.mjs')
await writeFile(outside, 'process.exit(0);\n')
// The escape guard is asserted on every platform through an absolute path.
await writeFile(
  configPath,
  hookConfig([{ id: 'escape', event: 'stop', command: outside.replace(/\\/g, '/') }])
)
await assert.rejects(loadHooksConfig(configPath, 'project'), /escapes/)

// Symlinked executables are covered only where the OS grants symlink creation
// (Windows without Developer Mode raises EPERM); the guard above is identical.
try {
  await symlink(outside, join(configDir, 'linked.mjs'))
  await writeFile(
    configPath,
    hookConfig([{ id: 'escape', event: 'stop', command: './linked.mjs' }])
  )
  await assert.rejects(loadHooksConfig(configPath, 'project'), /escapes/)
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
  console.warn('symlink escape case skipped: the platform denied symlink creation')
}

const nodeBin = join(configDir, process.platform === 'win32' ? 'node-bin.exe' : 'node-bin')
try {
  await link(process.execPath, nodeBin)
} catch {
  await copyFile(process.execPath, nodeBin)
}
const hookScript = (body: string): string =>
  `const chunks=[];process.stdin.on('data',(chunk)=>chunks.push(chunk));` +
  `process.stdin.on('end',()=>{${body}});`
const runnableHook = async (
  scriptPath: string,
  extra: Record<string, unknown> = {}
): Promise<Awaited<ReturnType<typeof loadHooksConfig>>[number]> => {
  await writeFile(
    configPath,
    hookConfig([
      { id: 'runnable', event: 'sessionStart', command: nodeBin, args: [scriptPath], ...extra }
    ])
  )
  const [hook] = await loadHooksConfig(configPath, 'project')
  hook.trustState = 'trusted'
  return hook
}

const okPath = join(root, 'ok.mjs')
await writeFile(
  okPath,
  hookScript(`process.stdout.write(JSON.stringify({additionalContext:'changed'}));`)
)
const runner = new HooksRunner(1)
const success = await runner.run(await runnableHook(okPath), {
  version: 1,
  event: 'sessionStart',
  sessionId: 's'
})
assert.equal(success.output.additionalContext, 'changed')

const slowPath = join(root, 'slow.mjs')
await writeFile(slowPath, hookScript(`setTimeout(()=>{},3000);`))
const slow = await runnableHook(slowPath, { timeoutMs: 100 })
const timed = await runner.run(slow, { version: 1, event: 'sessionStart', sessionId: 'slow' })
assert.equal(timed.record.status, 'timed-out')

const failingPath = join(root, 'failing.mjs')
await writeFile(failingPath, hookScript(`process.stderr.write('failure');process.exit(7);`))
const failing = await runnableHook(failingPath)
const failed = await runner.run(failing, { version: 1, event: 'sessionStart', sessionId: 'failed' })
assert.equal(failed.record.status, 'failed')
assert.match(failed.record.stderrSummary, /failure/)

const floodPath = join(root, 'flood.mjs')
await writeFile(floodPath, hookScript(`process.stdout.write('x'.repeat(300000));process.exit(0);`))
const flooded = await runner.run(await runnableHook(floodPath), {
  version: 1,
  event: 'sessionStart',
  sessionId: 'flood'
})
assert.equal(flooded.record.status, 'failed')

const concurrentRunner = new HooksRunner(1)
slow.timeoutMs = 5_000
const activeRun = concurrentRunner.run(slow, {
  version: 1,
  event: 'sessionStart',
  sessionId: 'active',
  cancellationKey: 'active'
})
await assert.rejects(
  concurrentRunner.run(slow, { version: 1, event: 'sessionStart', sessionId: 'second' }),
  /concurrency/
)
concurrentRunner.cancel('active')
const activeResult = await activeRun
// Windows terminates the tree with taskkill, which reports an exit code instead
// of a signal, so a cancelled hook surfaces as 'failed' there; both mean the
// hook stopped before completing and never produced output.
assert.equal(activeResult.record.status, process.platform === 'win32' ? 'failed' : 'canceled')
assert.deepEqual(activeResult.output, {})

console.log('hooks framework verification passed')
