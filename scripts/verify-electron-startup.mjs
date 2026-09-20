/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const root = process.cwd()
const port = 9250 + Math.floor(Math.random() * 100)
const userDataDir = mkdtempSync(join(tmpdir(), 'ola-electron-e2e-'))
const evidenceDir = join(root, 'docs/migrations/ts-runtime/evidence')
const screenshotPath = join(evidenceDir, 'electron-startup-2026-09-20.png')
mkdirSync(evidenceDir, { recursive: true })

const child = spawn(
  join(root, 'node_modules/.bin/electron'),
  [
    join(root, 'out/main/index.js'),
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`
  ],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
)

let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => {
  stdout += chunk.toString()
})
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString()
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function getTargets() {
  const response = await fetch(`http://127.0.0.1:${port}/json`)
  if (!response.ok) throw new Error(`DevTools endpoint returned ${response.status}`)
  return response.json()
}

async function waitForTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const targets = await getTargets()
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // Electron is still booting.
    }
    await sleep(500)
  }
  throw new Error('Timed out waiting for Electron page target')
}

function cdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1_000_000_000)
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString())
      if (message.id !== id) return
      ws.off('message', onMessage)
      if (message.error) reject(new Error(`${method}: ${message.error.message}`))
      else resolve(message.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

function readSettingsRoutes() {
  const source = readFileSync(
    join(root, 'src/renderer/src/components/settings/settings-registry.ts'),
    'utf8'
  )
  const registrySource = source.slice(
    source.indexOf('export const SETTINGS_REGISTRY'),
    source.indexOf('const pageById')
  )
  const routes = []
  const pagePattern = /\{\s*id:\s*'([^']+)'[\s\S]*?section:\s*'([^']+)'[\s\S]*?\n\s*\}/g
  for (const match of registrySource.matchAll(pagePattern)) {
    routes.push(`#/settings/${match[2]}/${match[1]}`)
  }
  if (routes.length === 0) throw new Error('Settings registry produced no routes')
  return routes
}

async function main() {
  const target = await waitForTarget()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  await cdp(ws, 'Runtime.enable')
  await cdp(ws, 'Page.enable')
  await sleep(4_000)

  const evaluation = await cdp(ws, 'Runtime.evaluate', {
    expression: `({
      title: document.title,
      url: location.href,
      bodyTextLength: document.body?.innerText?.length ?? 0,
      hasRoot: Boolean(document.querySelector('#root'))
    })`,
    returnByValue: true
  })
  const page = evaluation.result?.value
  if (!page?.hasRoot || !String(page.url).includes('out/renderer/index.html')) {
    throw new Error(`Unexpected Electron page state: ${JSON.stringify(page)}`)
  }

  const settingsRoutes = readSettingsRoutes()
  const routes = [...settingsRoutes, '#/usage', '#/pet-studio']
  for (const route of routes) {
    await cdp(ws, 'Runtime.evaluate', {
      expression: `window.location.hash = ${JSON.stringify(route)}`
    })
    await sleep(350)
    const routeState = await cdp(ws, 'Runtime.evaluate', {
      expression: `({
        url: location.href,
        bodyTextLength: document.body?.innerText?.length ?? 0,
        hasRoot: Boolean(document.querySelector('#root'))
      })`,
      returnByValue: true
    })
    const value = routeState.result?.value
    if (!value?.hasRoot || value.bodyTextLength < 80) {
      throw new Error(`Route smoke failed for ${route}: ${JSON.stringify(value)}`)
    }
  }

  await cdp(ws, 'Runtime.evaluate', { expression: `window.location.hash = '#/'` })
  await sleep(350)

  const screenshot = await cdp(ws, 'Page.captureScreenshot', { format: 'png' })
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  ws.close()

  const combinedLogs = `${stdout}\n${stderr}`
  const forbidden = [
    /(?:^|\n).*No handler registered.*$/im,
    /(?:^|\n).*Uncaught(?:\s|:).*$/im,
    /(?:^|\n).*startup failed.*$/im,
    /(?:^|\n).*Native Worker.*$/im,
    /(?:^|\n).*Ola\.Native\.Worker.*$/im,
    /(?:^|\n).*codegraph-worker.*$/im,
    /(?:^|\n).*native-worker.*$/im
  ]
  const failures = forbidden.filter((pattern) => pattern.test(combinedLogs))
  if (failures.length > 0) {
    const matchingLines = combinedLogs
      .split('\n')
      .filter((line) =>
        /No handler registered|Uncaught|startup failed|Native Worker|codegraph-worker|native-worker/i.test(
          line
        )
      )
    throw new Error(
      `Electron startup log contains forbidden patterns: ${failures.join(', ')}\n${matchingLines.join('\n')}`
    )
  }

  const logPath = join(evidenceDir, 'electron-startup-2026-09-20.log')
  writeFileSync(logPath, combinedLogs)
  console.log(
    JSON.stringify(
      {
        passed: true,
        title: page.title,
        url: page.url,
        bodyTextLength: page.bodyTextLength,
        routeCount: routes.length,
        screenshotPath,
        logPath
      },
      null,
      2
    )
  )
}

try {
  await main()
} finally {
  child.kill('SIGTERM')
  await sleep(250)
  if (!child.killed) child.kill('SIGKILL')
}
