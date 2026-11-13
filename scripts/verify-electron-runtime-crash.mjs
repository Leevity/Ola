import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const root = process.cwd()
const port = 9350 + Math.floor(Math.random() * 100)
const dataRoot = mkdtempSync(join(tmpdir(), 'ola-runtime-crash-'))
const prompt = `OLA_UTILITY_CRASH_PROBE_${Date.now()}`
const heldResponses = new Set()
const fixture = createServer((request, response) => {
  if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== '/v1/chat/completions') {
    response.writeHead(404).end()
    return
  }
  let body = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    const messages = JSON.parse(body).messages ?? []
    const system = messages.find((message) => message.role === 'system')?.content ?? ''
    const userText = messages
      .filter((message) => message.role === 'user')
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .join('\n')
    const reply = system.includes('strict task router')
      ? '{"taskType":"other","route":"main","confidence":"high"}'
      : system.includes('You are a title generator')
        ? '{"title":"Runtime crash probe","icon":"cpu"}'
        : null
    if (reply) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(reply)}}}]}\n\ndata: [DONE]\n\n`
      )
      return
    }
    if (!userText.includes(prompt)) {
      response.writeHead(500).end('Unexpected fixture request')
      return
    }
    heldResponses.add(response)
    response.on('close', () => heldResponses.delete(response))
    // Keep the user facing model turn active until the utilityProcess is killed.
  })
})
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve))
const fixturePort = fixture.address().port

mkdirSync(join(dataRoot, 'electron-user-data'), { recursive: true })
writeFileSync(join(dataRoot, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
writeFileSync(
  join(dataRoot, 'settings.json'),
  JSON.stringify({
    'ola-settings': {
      state: { onboardingCompleted: true, onboardingCompletedAt: Date.now() },
      version: 29
    }
  })
)
writeFileSync(
  join(dataRoot, 'config.json'),
  JSON.stringify({
    'ola-providers': {
      state: {
        providers: [
          {
            id: 'crash-probe-provider',
            name: 'Local crash probe fixture',
            type: 'openai-chat',
            apiKey: '',
            baseUrl: `http://127.0.0.1:${fixturePort}/v1`,
            enabled: true,
            requiresApiKey: false,
            createdAt: Date.now(),
            models: [
              {
                id: 'crash-probe-model',
                name: 'Crash probe model',
                enabled: true,
                category: 'chat'
              }
            ]
          }
        ],
        activeProviderId: 'crash-probe-provider',
        activeModelId: 'crash-probe-model'
      },
      version: 0
    }
  })
)

const electronBinary = require('electron')
const child = spawn(
  electronBinary,
  [
    join(root, 'out/main/index.js'),
    '--no-sandbox',
    '--disable-gpu',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(dataRoot, 'electron-user-data')}`
  ],
  {
    cwd: root,
    env: { ...process.env, OLA_E2E_DATA_ROOT: dataRoot },
    stdio: ['ignore', 'pipe', 'pipe']
  }
)

let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => (stdout += chunk.toString()))
child.stderr.on('data', (chunk) => (stderr += chunk.toString()))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deadline = (ms) => Date.now() + ms

async function waitFor(description, predicate, timeoutMs = 30_000) {
  const until = deadline(timeoutMs)
  while (Date.now() < until) {
    const value = await predicate()
    if (value) return value
    await sleep(200)
  }
  throw new Error(
    `Timed out waiting for ${description}; logs: ${`${stdout}\n${stderr}`.slice(-2400)}`
  )
}

async function waitForPage() {
  return await waitFor('Electron DevTools page', async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      if (!response.ok) return null
      return (await response.json()).find(
        (target) => target.type === 'page' && target.webSocketDebuggerUrl
      )
    } catch {
      return null
    }
  })
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

async function main() {
  const target = await waitForPage()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  await cdp(ws, 'Runtime.enable')
  await waitFor('renderer root', async () => {
    const result = await cdp(ws, 'Runtime.evaluate', {
      expression: 'Boolean(document.querySelector("#root")?.firstElementChild)',
      returnByValue: true
    })
    return result.result?.value
  })
  await sleep(1500)
  await waitFor('initial isolated runtime child', () =>
    stdout.match(/\[TsRuntime\] isolated runtime ready \(pid (\d+)\)/)
  )

  const editor = await cdp(ws, 'Runtime.evaluate', {
    expression: `(() => { const el = document.querySelector('[role="textbox"][contenteditable="true"]'); if (!el) return false; el.focus(); return document.activeElement === el })()`,
    returnByValue: true
  })
  if (editor.result?.value !== true) throw new Error('Home composer is not editable')
  const editorPoint = await cdp(ws, 'Runtime.evaluate', {
    expression: `(() => { const el = document.querySelector('[role="textbox"][contenteditable="true"]'); const rect = el?.getBoundingClientRect(); return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null })()`,
    returnByValue: true
  })
  await cdp(ws, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: editorPoint.result.value.x,
    y: editorPoint.result.value.y,
    button: 'left',
    clickCount: 1
  })
  await cdp(ws, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: editorPoint.result.value.x,
    y: editorPoint.result.value.y,
    button: 'left',
    clickCount: 1
  })
  await cdp(ws, 'Input.insertText', { text: prompt })
  await waitFor(
    'enabled composer send button',
    async () => {
      const result = await cdp(ws, 'Runtime.evaluate', {
        expression: `(() => { const button = document.querySelector('.composer-send'); return Boolean(button && !button.disabled) })()`,
        returnByValue: true
      })
      return result.result?.value
    },
    15_000
  ).catch(async (error) => {
    const state = await cdp(ws, 'Runtime.evaluate', {
      expression: `({ url: location.href, body: document.body?.innerText?.slice(-900), editors: Array.from(document.querySelectorAll('[role="textbox"][contenteditable="true"]')).map((el) => ({ text: el.innerText, aria: el.getAttribute('aria-label') })), buttons: Array.from(document.querySelectorAll('button')).map((button) => ({ text: button.textContent?.trim(), title: button.title, className: String(button.className), disabled: button.disabled })).filter((button) => /send|发送|composer/i.test([button.text, button.title, button.className].join(' '))).slice(-10) })`,
      returnByValue: true
    })
    throw new Error(`${error.message}\nComposer state: ${JSON.stringify(state.result?.value)}`)
  })
  const sent = await cdp(ws, 'Runtime.evaluate', {
    expression: `(() => { const button = document.querySelector('.composer-send'); if (!button || button.disabled) return false; button.click(); return true })()`,
    returnByValue: true
  })
  if (sent.result?.value !== true) throw new Error('Could not submit crash probe prompt')

  await waitFor('local fixture request', () => heldResponses.size > 0)
  const dbPath = join(dataRoot, 'electron-user-data', 'ts-runtime', 'runtime-v2', 'runs.db')
  const db = await waitFor('active run in journal', () => {
    try {
      const connection = new DatabaseSync(dbPath, { readOnly: true })
      const row = connection
        .prepare(
          "SELECT id, status, spec FROM runs WHERE status IN ('running','queued') ORDER BY created_at DESC"
        )
        .all()
        .find((candidate) => String(JSON.parse(candidate.spec).prompt).includes(prompt))
      connection.close()
      return row?.status === 'running' ? row : null
    } catch {
      return null
    }
  })
  const originalPid = Number(
    stdout.match(/\[TsRuntime\] isolated runtime ready \(pid (\d+)\)/)?.[1]
  )
  if (!originalPid) throw new Error('Could not identify the first utilityProcess PID')

  process.kill(originalPid, 'SIGKILL')

  const resync = await waitFor('active stream resync request', () =>
    `${stdout}\n${stderr}`.match(
      /\[TsRuntime\] requesting resync for (\d+) run stream\(s\) \(RUNTIME_DISCONNECTED\)/
    )
  )
  const reconnect = await waitFor('restart and successful hello handshake', () =>
    stdout.match(/\[TsRuntime\] isolated runtime reconnected after journal recovery/)
  )
  const readyPids = [...stdout.matchAll(/\[TsRuntime\] isolated runtime ready \(pid (\d+)\)/g)].map(
    (match) => Number(match[1])
  )
  if (readyPids.length < 2 || readyPids[1] === originalPid)
    throw new Error(`Runtime did not restart with a new PID: ${JSON.stringify(readyPids)}`)

  const recovered = await waitFor('interrupted journal status', () => {
    const connection = new DatabaseSync(dbPath, { readOnly: true })
    const row = connection.prepare('SELECT id, status FROM runs WHERE id=?').get(db.id)
    const events = connection
      .prepare("SELECT data FROM events WHERE run_id=? AND type='run.status' ORDER BY seq")
      .all(db.id)
      .map((event) => JSON.parse(event.data))
    connection.close()
    const finalStatus = events.at(-1)
    return row?.status === 'interrupted' &&
      finalStatus?.reason === 'RUNTIME_RESTARTED_REVIEW_SIDE_EFFECTS'
      ? { status: row.status, finalStatus }
      : null
  })
  const rendererAlive = await cdp(ws, 'Runtime.evaluate', {
    expression: `Boolean(document.querySelector('#root')?.firstElementChild)`,
    returnByValue: true
  })
  if (rendererAlive.result?.value !== true)
    throw new Error('Renderer did not survive utilityProcess crash')

  const result = {
    passed: true,
    utilityProcessPids: readyPids.slice(0, 2),
    runId: db.id,
    resyncStreamCount: Number(resync[1]),
    runtimeReconnected: Boolean(reconnect),
    recoveredStatus: recovered,
    mainWindowSurvived: true,
    fixture: '127.0.0.1 OpenAI-compatible endpoint',
    isolatedDataRoot: true
  }
  const evidencePath = join(root, 'docs/qa/assets/utilityprocess-crash-2026-11-13.json')
  mkdirSync(join(root, 'docs/qa/assets'), { recursive: true })
  writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ ...result, evidencePath }, null, 2))
  ws.close()
}

try {
  await main()
} finally {
  for (const response of heldResponses) response.destroy()
  fixture.closeAllConnections()
  fixture.close()
  child.kill('SIGTERM')
  await sleep(250)
  if (!child.killed) child.kill('SIGKILL')
  rmSync(dataRoot, { recursive: true, force: true })
}
