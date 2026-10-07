/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const executable = process.argv[2] ? resolve(process.argv[2]) : ''
const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
if (process.argv.some((arg) => arg.startsWith('--legacy'))) {
  throw new Error('Legacy builds do not honor OLA_E2E_DATA_ROOT and cannot be tested safely here')
}
if (!executable) {
  throw new Error(
    'Usage: node scripts/verify-packaged-electron-process-startup.mjs <installed-app-executable>'
  )
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const expectedVersion = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version
const archivePath = join(dirname(executable), 'resources', 'app.asar')
const installedVersion = JSON.parse(
  asar.extractFile(archivePath, 'package.json').toString()
).version
const mainBundle = asar.extractFile(archivePath, 'out\\main\\index.js').toString()
if (installedVersion !== expectedVersion || !mainBundle.includes('OLA_E2E_DATA_ROOT')) {
  throw new Error('Packaged app must match this source version and support isolated E2E data')
}

const dataRoot = mkdtempSync(join(tmpdir(), 'ola-packaged-process-startup-'))
writeFileSync(join(dataRoot, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
const rendererUrl = pathToFileURL(
  join(dirname(executable), 'resources', 'app.asar', 'out', 'renderer', 'index.html')
).href
const child = spawn(
  executable,
  ['--no-sandbox', '--disable-gpu', `--user-data-dir=${join(dataRoot, 'electron-user-data')}`],
  {
    cwd: dirname(executable),
    env: { ...process.env, OLA_E2E_DATA_ROOT: dataRoot },
    stdio: ['ignore', 'pipe', 'pipe']
  }
)

let logs = ''
child.stdout.on('data', (chunk) => (logs += chunk.toString()))
child.stderr.on('data', (chunk) => (logs += chunk.toString()))
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const timeout = Date.now() + 60_000
let passed = false

try {
  while (Date.now() < timeout) {
    if (child.exitCode !== null) throw new Error(`Packaged app exited with code ${child.exitCode}`)
    const loadedInstalledRenderer =
      logs.includes('[Main] Renderer finished loading:') && logs.includes(rendererUrl)
    const runtimeReady = logs.includes('[TsRuntime] desktop host ready')
    const windowVisible = /isVisible:\s*true/.test(logs)
    if (loadedInstalledRenderer && runtimeReady && windowVisible) {
      const forbiddenStartupLog =
        /Unhandled rejection|No handler registered|startup failed|Native Worker|Ola\.Native\.Worker|codegraph-worker|native-worker/i
      if (forbiddenStartupLog.test(logs)) {
        throw new Error('Packaged app reported startup error or legacy runtime marker')
      }
      console.log(
        JSON.stringify(
          {
            passed: true,
            executable,
            dataRoot,
            loadedInstalledRenderer,
            runtimeReady,
            windowVisible
          },
          null,
          2
        )
      )
      passed = true
      break
    }
    await sleep(500)
  }
  if (!passed) throw new Error('Timed out waiting for packaged Electron startup')
} catch (error) {
  console.error(logs)
  throw error
} finally {
  if (child.exitCode === null) child.kill('SIGTERM')
  await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), sleep(5_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}
