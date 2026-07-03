/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Launch wrapper for `electron-vite dev` that ensures DOTNET_ROOT is set for the
// spawned Electron process tree. Setting the variable in predev.mjs is not
// enough because npm only forwards env vars that were set before the script
// ran; predev's process.env mutations never escape that node process.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const isPosix = process.platform !== 'win32'

if (!process.env.DOTNET_ROOT && isPosix) {
  const userDotnet = path.join(homedir(), '.dotnet')
  if (existsSync(userDotnet)) {
    process.env.DOTNET_ROOT = userDotnet
    console.log(`[launch-dev] DOTNET_ROOT=${userDotnet}`)
  }
}

const child = spawn(
  'npx',
  ['--no-install', 'electron-vite', 'dev'],
  { stdio: 'inherit', env: process.env }
)

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})

process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
