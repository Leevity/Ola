import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { handoverBusinessDatabase } from '../../src/runtime/storage/business-handover-coordinator'
import { writeBusinessHandoverMarker } from '../../src/main/db/business-handover-state'

describe('Electron handover restart', () => {
  const originalRoot = process.env.OLA_E2E_DATA_ROOT
  const originalApp = process.env.OLA_STAGING_APP
  let directory = ''

  afterEach(async () => {
    if (originalRoot === undefined) delete process.env.OLA_E2E_DATA_ROOT
    else process.env.OLA_E2E_DATA_ROOT = originalRoot
    if (originalApp === undefined) delete process.env.OLA_STAGING_APP
    else process.env.OLA_STAGING_APP = originalApp
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('restores TS ownership before a packaged Electron process can start Native', async () => {
    const appPath = process.env.OLA_STAGING_APP
    if (!appPath) return
    const launchPath =
      process.platform === 'darwin' && appPath.endsWith('.app')
        ? join(appPath, 'Contents', 'MacOS', 'Ola')
        : appPath
    directory = await mkdtemp(join(tmpdir(), 'ola-electron-handover-restart-'))
    await writeFile(join(directory, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
    process.env.OLA_E2E_DATA_ROOT = directory
    const worker = await startWorker(directory)
    try {
      const dbPath = join(directory, 'data.db')
      expect((await worker.client.request('db/initialize', { dbPath })).success).toBe(true)
      expect(
        (
          await worker.client.request('db/sessions-create', {
            dbPath,
            id: 'electron-restart-session',
            title: 'Electron restart handover',
            mode: 'chat',
            workspaceId: 'local-personal'
          })
        ).success
      ).toBe(true)
      const handover = await handoverBusinessDatabase({
        sourcePath: dbPath,
        backupDirectory: join(directory, 'backups'),
        quiesceLegacyWriter: async () => {
          worker.client.close()
          worker.child.kill('SIGTERM')
          if (worker.child.exitCode === null && worker.child.signalCode === null)
            await new Promise((resolve) => worker.child.once('exit', resolve))
        }
      })
      await handover.repository.close()
      writeBusinessHandoverMarker({
        manifestPath: handover.snapshot.manifestPath,
        backupPath: handover.snapshot.backupPath
      })

      const child = spawn(launchPath, ['--no-sandbox'], {
        env: { ...process.env },
        stdio: ['ignore', 'ignore', 'pipe']
      })
      const stderr: Buffer[] = []
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      const earlyExit = await Promise.race([
        new Promise<{ code: number | null; signal: string | null }>((resolve) =>
          child.once('exit', (code, signal) => resolve({ code, signal }))
        ),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000))
      ])
      if (earlyExit) {
        throw new Error(
          `Electron exited during restart: ${JSON.stringify(earlyExit)}\n${Buffer.concat(stderr)}`
        )
      }
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    } finally {
      if (worker.child.exitCode === null && worker.child.signalCode === null)
        worker.child.kill('SIGTERM')
    }
  }, 40_000)
})
