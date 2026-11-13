/**
 * Local aggregate for the Electron-backed acceptance scenarios. Each scenario is the same
 * command an engineer would run by hand; this only sequences them and reports what was
 * proven versus what was skipped because no packaged app was supplied. It deliberately is
 * not wired into any CI workflow: these suites boot a real desktop app, so they are slower
 * and more host-sensitive than the rest of the `verify:ci-*` gates.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const packagedExecutable = process.env.OLA_PACKAGED_EXE
  ? resolve(process.env.OLA_PACKAGED_EXE)
  : undefined
if (packagedExecutable && !existsSync(packagedExecutable))
  throw new Error(`OLA_PACKAGED_EXE does not exist: ${packagedExecutable}`)

const scenarios = [
  { id: 'startup', kind: 'npm', script: 'verify:electron-startup' },
  { id: 'session-create', kind: 'npm', script: 'verify:session-create-electron' },
  { id: 'session-delete', kind: 'npm', script: 'verify:session-delete-electron' },
  { id: 'settings-save', kind: 'npm', script: 'verify:settings-save-electron' },
  { id: 'resources-command', kind: 'npm', script: 'verify:resources-command-electron' },
  { id: 'top-level-pages', kind: 'npm', script: 'verify:top-level-pages-electron' },
  { id: 'pending-queue', kind: 'npm', script: 'verify:pending-queue-electron' },
  {
    id: 'packaged-startup',
    kind: 'npm',
    script: 'verify:packaged-startup',
    args: () => [packagedExecutable],
    requiresPackagedApp: true
  },
  {
    id: 'cron-session-recovery',
    kind: 'vitest',
    file: 'tests/runtime/cron-session-recovery-electron.test.ts',
    requiresPackagedApp: true
  }
]

const keepGoing = process.argv.includes('--keep-going')
const results = []

for (const scenario of scenarios) {
  if (scenario.requiresPackagedApp && !packagedExecutable) {
    results.push({ id: scenario.id, status: 'skipped' })
    console.log(`\n[electron-suite] ${scenario.id}: SKIPPED (set OLA_PACKAGED_EXE)`)
    continue
  }
  const command =
    scenario.kind === 'npm'
      ? { bin: process.execPath, args: npmArgs(scenario.script, scenario.args?.() ?? []) }
      : {
          bin: process.execPath,
          args: [`${root}/node_modules/vitest/vitest.mjs`, 'run', scenario.file]
        }
  console.log(`\n[electron-suite] ${scenario.id}: ${command.args.join(' ')}`)
  const result = spawnSync(command.bin, command.args, {
    cwd: root,
    // The npm launcher must stay resolvable inside each scenario, so the child inherits
    // the environment this script was started with.
    env: {
      ...process.env,
      ...(packagedExecutable ? { OLA_PACKAGED_EXE: packagedExecutable } : {})
    },
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  const status = result.status === 0 ? 'passed' : `failed (${result.status})`
  results.push({ id: scenario.id, status })
  console.log(`[electron-suite] ${scenario.id}: ${status.toUpperCase()}`)
  if (status !== 'passed' && !keepGoing) break
}

function npmArgs(script, extra) {
  const npm = process.env.npm_execpath
  if (!npm) throw new Error('Run this suite with `npm run verify:ci-electron`.')
  return [npm, 'run', script, ...(extra.length ? ['--', ...extra] : [])]
}

const failed = results.filter((entry) => entry.status !== 'passed' && entry.status !== 'skipped')
const skipped = results.filter((entry) => entry.status === 'skipped')
console.log('\n[electron-suite] summary')
for (const entry of results) console.log(`  ${entry.id}: ${entry.status}`)
if (skipped.length)
  console.log(`[electron-suite] ${skipped.length} scenario(s) need a packaged app.`)
if (failed.length) {
  console.error(`[electron-suite] ${failed.length} scenario(s) failed.`)
  process.exitCode = 1
} else if (skipped.length) {
  console.log('[electron-suite] Every scenario that could run passed.')
}
