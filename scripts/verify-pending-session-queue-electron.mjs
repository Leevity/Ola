import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const vitest = resolve(root, 'node_modules/vitest/vitest.mjs')
const result = spawnSync(
  process.execPath,
  [vitest, 'run', 'tests/runtime/pending-session-queue-electron.test.ts'],
  {
    cwd: root,
    env: { ...process.env, RUN_PENDING_QUEUE_ELECTRON_E2E: '1' },
    stdio: 'inherit'
  }
)

if (result.error) throw result.error
process.exitCode = result.status ?? 1
