import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// electron-vite's isolated preload reporter currently calls terminal cursor
// methods even when stdout is a pipe. Preserve isolated entries and make only
// those terminal operations inert for CI and redirected build logs.
if (!process.stdout.isTTY) {
  process.stdout.moveCursor ??= () => false
  process.stdout.clearLine ??= () => false
  process.stdout.cursorTo ??= () => false
}

const require = createRequire(import.meta.url)
const cli = resolve(dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js')
process.argv = [process.execPath, cli, 'build', ...process.argv.slice(2)]
await import(pathToFileURL(cli).href)
