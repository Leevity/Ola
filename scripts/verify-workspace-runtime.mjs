import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const vitest = resolve(root, 'node_modules/vitest/vitest.mjs')
const result = spawnSync(
  process.execPath,
  [
    vitest,
    'run',
    'tests/runtime/desktop-runtime-offline-workspace.test.ts',
    'tests/runtime/offline-workspace-account-client.test.ts',
    'tests/runtime/workspace-model-store.test.ts',
    'tests/runtime/workspace-directory.test.ts'
  ],
  { cwd: root, stdio: 'inherit' }
)

if (result.error) throw result.error
process.exitCode = result.status ?? 1
