import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const vitest = resolve(projectRoot, 'node_modules/vitest/vitest.mjs')
const result = spawnSync(
  process.execPath,
  [
    vitest,
    'run',
    'tests/runtime/session-run-lifecycle.test.ts',
    'tests/runtime/final-outcome-artifacts.test.ts'
  ],
  { cwd: projectRoot, stdio: 'inherit' }
)

if (result.error) throw result.error
process.exitCode = result.status ?? 1
