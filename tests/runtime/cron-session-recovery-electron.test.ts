import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'

const packagedExecutable = process.env.OLA_PACKAGED_EXE
const asar = createRequire(import.meta.url)('@electron/asar')
let dataRoot: string | undefined
let repository: BusinessRepository | undefined
let appProcess: ChildProcessWithoutNullStreams | undefined

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

async function stopApp(): Promise<void> {
  const child = appProcess
  appProcess = undefined
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) return
    await sleep(100)
  }
  child.kill('SIGKILL')
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) return
    await sleep(100)
  }
  throw new Error('Packaged Electron did not exit after termination')
}

async function startApp(executable: string, expectedLog: string): Promise<void> {
  if (!dataRoot) throw new Error('Missing isolated Cron data root')
  const child = spawn(
    executable,
    ['--no-sandbox', '--disable-gpu', `--user-data-dir=${join(dataRoot, 'electron-user-data')}`],
    {
      cwd: dirname(executable),
      env: { ...process.env, OLA_E2E_DATA_ROOT: dataRoot },
      stdio: 'pipe'
    }
  )
  appProcess = child
  let logs = ''
  child.stdout.on('data', (chunk) => (logs += chunk.toString()))
  child.stderr.on('data', (chunk) => (logs += chunk.toString()))
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (logs.includes(expectedLog)) return
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Packaged Electron exited before Cron recovery: ${logs.slice(-2000)}`)
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${expectedLog}: ${logs.slice(-2000)}`)
}

afterEach(async () => {
  await stopApp()
  await repository?.close()
  repository = undefined
  if (!dataRoot) return
  const target = resolve(dataRoot)
  const tempRoot = resolve(tmpdir())
  if (
    !target.startsWith(`${tempRoot}${sep}`) ||
    !basename(target).startsWith('ola-cron-electron-')
  ) {
    throw new Error(`Unexpected Cron E2E data root: ${target}`)
  }
  rmSync(target, { recursive: true, force: true })
  dataRoot = undefined
})

describe('packaged Electron Cron recovery', () => {
  it.skipIf(!packagedExecutable)(
    'delivers a completed run once after an actual application restart',
    async () => {
      const executable = resolve(packagedExecutable!)
      expect(existsSync(executable)).toBe(true)
      const archive = join(dirname(executable), 'resources', 'app.asar')
      expect(asar.extractFile(archive, 'out\\main\\index.js').toString()).toContain(
        'OLA_E2E_DATA_ROOT'
      )
      dataRoot = mkdtempSync(join(tmpdir(), 'ola-cron-electron-'))
      writeFileSync(join(dataRoot, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')

      await startApp(executable, '[TsRuntime] desktop host ready')
      await stopApp()

      repository = new BusinessRepository({ path: join(dataRoot, 'data.db'), mode: 'direct' })
      const now = Date.now()
      await repository.createSession({
        id: 'electron-recovery-session',
        title: 'Electron recovery',
        mode: 'chat',
        createdAt: now,
        updatedAt: now,
        workspaceId: 'local-personal'
      })
      await repository.createCronJob({
        id: 'electron-recovery-job',
        workspaceId: 'local-personal',
        name: 'Electron recovery',
        scheduleKind: 'at',
        scheduleAt: now + 3_600_000,
        prompt: 'Summarize',
        deliveryMode: 'session',
        deliveryTarget: 'electron-recovery-session',
        createdAt: now
      })
      await repository.createCronRun({
        id: 'electron-recovery-run',
        jobId: 'electron-recovery-job',
        workspaceId: 'local-personal',
        startedAt: now,
        deliveryModeSnapshot: 'session',
        deliveryTargetSnapshot: 'electron-recovery-session'
      })
      await repository.finishCronRun({
        id: 'electron-recovery-run',
        workspaceId: 'local-personal',
        finishedAt: now + 1,
        status: 'success',
        toolCallCount: 0,
        outputSummary: 'Recovered by Electron'
      })
      expect(await repository.pendingCronSessionDeliveries()).toHaveLength(1)
      await repository.close()
      repository = undefined

      for (let restart = 0; restart < 2; restart += 1) {
        await startApp(executable, '[CronScheduler] Loaded 1/1 persisted cron jobs')
        await stopApp()
      }
      repository = new BusinessRepository({ path: join(dataRoot, 'data.db'), mode: 'direct' })
      expect(await repository.pendingCronSessionDeliveries()).toEqual([])
      expect(
        await repository.messages<{ id: string; content: string }>(
          'electron-recovery-session',
          'local-personal'
        )
      ).toEqual([
        expect.objectContaining({
          id: 'cron-session-electron-recovery-run',
          content: JSON.stringify('Recovered by Electron')
        })
      ])
    },
    180_000
  )
})
