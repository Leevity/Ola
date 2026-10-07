/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const executable = process.argv[2] ? resolve(process.argv[2]) : ''
if (!executable) {
  throw new Error(
    'Usage: node scripts/verify-packaged-electron-startup.mjs <packaged-app-executable>'
  )
}

const root = process.cwd()
const port = 9400 + Math.floor(Math.random() * 100)
const dataRoot = mkdtempSync(join(tmpdir(), 'ola-packaged-startup-'))
writeFileSync(join(dataRoot, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
const evidenceDir = join(root, 'docs/migrations/ts-runtime/evidence')
mkdirSync(evidenceDir, { recursive: true })
const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const screenshotPath = join(evidenceDir, `electron-packaged-startup-${timestamp}.png`)
const logPath = join(evidenceDir, `electron-packaged-startup-${timestamp}.txt`)
const child = spawn(
  executable,
  [
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(dataRoot, 'electron-user-data')}`
  ],
  {
    cwd: dirname(executable),
    env: { ...process.env, OLA_E2E_DATA_ROOT: dataRoot },
    stdio: ['ignore', 'pipe', 'pipe']
  }
)

let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => (stdout += chunk.toString()))
child.stderr.on('data', (chunk) => (stderr += chunk.toString()))
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

async function waitForPageTarget() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Packaged app exited with code ${child.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`, {
        signal: AbortSignal.timeout(500)
      })
      if (response.ok) {
        const targets = await response.json()
        const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
        if (page) return page
      }
    } catch {
      // The packaged app is still starting.
    }
    await sleep(500)
  }
  throw new Error('Timed out waiting for the packaged Electron renderer page')
}

function cdp(ws, method, params = {}) {
  return new Promise((resolveCdp, rejectCdp) => {
    const id = Math.floor(Math.random() * 1_000_000_000)
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      rejectCdp(new Error(`${method} timed out`))
    }, 5_000)
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString())
      if (message.id !== id) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      if (message.error) rejectCdp(new Error(`${method}: ${message.error.message}`))
      else resolveCdp(message.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

let ws
let failure
try {
  const target = await waitForPageTarget()
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolveOpen, rejectOpen) => {
    ws.once('open', resolveOpen)
    ws.once('error', rejectOpen)
  })

  const rendererErrors = []
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.method === 'Runtime.exceptionThrown') {
      rendererErrors.push(message.params.exceptionDetails)
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      rendererErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '))
    }
  })

  await cdp(ws, 'Runtime.enable')
  await cdp(ws, 'Page.enable')
  await sleep(4_000)
  const result = await cdp(ws, 'Runtime.evaluate', {
    expression: `({ title: document.title, url: location.href, bodyTextLength: document.body?.innerText?.length ?? 0, hasRoot: Boolean(document.querySelector('#root')) })`,
    returnByValue: true
  })
  const page = result.result?.value
  if (!page?.hasRoot || !String(page.url).includes('out/renderer/index.html')) {
    throw new Error(`Unexpected packaged renderer page: ${JSON.stringify(page)}`)
  }
  if (page.bodyTextLength < 80) {
    throw new Error(`Packaged renderer body is unexpectedly short: ${JSON.stringify(page)}`)
  }
  const unexpectedErrors = rendererErrors.filter((error) => {
    const value = typeof error === 'string' ? error : JSON.stringify(error)
    return (
      !value.includes('Electron sandboxed_renderer.bundle.js') &&
      !value.includes("Cannot destructure property 'preloadScripts'")
    )
  })
  if (unexpectedErrors.length > 0) {
    throw new Error(`Packaged renderer reported errors: ${JSON.stringify(unexpectedErrors)}`)
  }

  const combinedLogs = `${stdout}\n${stderr}`
  if (!/isVisible:\s*true/.test(combinedLogs)) {
    throw new Error('Packaged Electron loaded the renderer, but its main window was not visible')
  }
  if (
    /Unhandled rejection|No handler registered|startup failed|Native Worker|Ola\.Native\.Worker|codegraph-worker|native-worker/i.test(
      combinedLogs
    )
  ) {
    throw new Error(
      `Packaged startup logs contain an error or legacy runtime marker:\n${combinedLogs}`
    )
  }

  const screenshot = await cdp(ws, 'Page.captureScreenshot', { format: 'png' })
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  writeFileSync(logPath, combinedLogs)
  console.log(
    JSON.stringify({ passed: true, executable, ...page, screenshotPath, logPath }, null, 2)
  )
} catch (error) {
  failure = error
} finally {
  ws?.close()
  if (child.exitCode === null) child.kill('SIGTERM')
  await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), sleep(5_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
  writeFileSync(logPath, `${stdout}\n${stderr}`)
}

if (failure) {
  console.error(`Packaged Electron startup verification failed. Logs: ${logPath}`)
  throw failure
}
