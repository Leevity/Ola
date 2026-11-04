// Launch wrapper for `electron-vite dev` that prepares the TypeScript runtime
// worker assets before starting Electron.

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

// electron-vite's isolated preload reporter calls terminal cursor methods even
// when stdout is a pipe. Keep those operations inert for redirected dev logs.
if (!process.stdout.isTTY) {
  process.stdout.moveCursor ??= () => false
  process.stdout.clearLine ??= () => false
  process.stdout.cursorTo ??= () => false
}

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

const require = createRequire(import.meta.url)
const cli = resolve(dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js')
process.argv = [process.execPath, cli, 'dev']
await import(pathToFileURL(cli).href)
