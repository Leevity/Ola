import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const root = resolve(process.argv[2] ?? process.cwd())
const workerName = readdirSync(join(root, 'out/renderer/assets')).find((n) =>
  /^ts-language-worker-.*\.js$/.test(n)
)
if (!workerName) throw new Error('no built ts-language-worker asset')

const port = 9600 + Math.floor(Math.random() * 100)
const dataRoot = mkdtempSync(join(tmpdir(), 'ola-worker-probe-'))
writeFileSync(join(dataRoot, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
const child = spawn(
  require('electron'),
  [
    join(root, 'out/main/index.js'),
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(dataRoot, 'user-data')}`
  ],
  { cwd: root, env: { ...process.env, OLA_E2E_DATA_ROOT: dataRoot }, stdio: ['ignore', 'pipe', 'pipe'] }
)
let logs = ''
child.stdout.on('data', (c) => (logs += c.toString()))
child.stderr.on('data', (c) => (logs += c.toString()))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function target() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(500) })
      if (res.ok) {
        const list = await res.json()
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        if (page) return page
      }
    } catch {}
    await sleep(500)
  }
  throw new Error('no page target')
}

function cdp(ws, method, params = {}) {
  return new Promise((res, rej) => {
    const id = Math.floor(Math.random() * 1e9)
    const timer = setTimeout(() => rej(new Error(`cdp timeout ${method}`)), 30000)
    const onMessage = (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.id !== id) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

const page = await target()
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.once('open', res)
  ws.once('error', rej)
})
await cdp(ws, 'Runtime.enable')
await sleep(3000)

const expression = `(async () => {
  const url = new URL(${JSON.stringify('assets/' + workerName)}, location.href).href
  const out = { url, protocol: location.protocol, constructed: false, response: null, error: null }
  try {
    const worker = new Worker(url)
    out.constructed = true
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker reply timeout')), 20000)
      worker.onmessage = (event) => {
        if (event.data && event.data.type === 'diagnostics') {
          clearTimeout(timer)
          resolve(event.data)
        }
      }
      worker.onerror = (event) => {
        clearTimeout(timer)
        reject(new Error('worker error: ' + event.message))
      }
      worker.postMessage({ id: 1, type: 'open', path: '/probe/x.ts', content: "const count: number = 'no'\\n" })
      worker.postMessage({ id: 2, type: 'diagnostics', path: '/probe/x.ts' })
    })
    out.response = reply.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message }))
    worker.terminate()
  } catch (error) {
    out.error = String(error && error.message ? error.message : error)
  }
  return out
})()`

const result = await cdp(ws, 'Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true
})
console.log(JSON.stringify(result.result?.value ?? result, null, 2))
ws.close()
child.kill('SIGTERM')
await sleep(300)
if (!child.killed) child.kill('SIGKILL')