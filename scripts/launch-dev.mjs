// Launch wrapper for `electron-vite dev` that prepares the TypeScript runtime
// worker assets before starting Electron.

import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'

// The Main bundle resolves SQLite workers by sibling URL at runtime. Vite does
// not discover those dynamic Worker URLs, so build their explicit assets before
// Electron starts rather than leaving development mode without the TS runtime.
const runtimeBuild = spawnSync(process.execPath, ['scripts/build-ts-runtime.mjs'], {
  cwd: process.cwd(),
  stdio: 'inherit'
})
if (runtimeBuild.status !== 0) {
  console.error('[launch-dev] Failed to prepare TS runtime worker assets.')
  process.exit(runtimeBuild.status ?? 1)
}

const isWin = process.platform === 'win32'
const command = isWin ? 'node_modules\\.bin\\electron-vite.cmd' : 'node_modules/.bin/electron-vite'
const args = ['dev']

const child = spawn(command, args, {
  stdio: 'inherit',
  env: process.env,
  shell: isWin
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})

process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
