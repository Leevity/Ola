// Phase 0.1 asked for a real Profiler distribution over one long streamed answer.
// `streaming-perf.ts` hard-gates the monitor on `import.meta.env.DEV`, so the
// production renderer used by verify:electron-startup can never install it.
// This probe serves the renderer through Vite's dev server (DEV=true) while still
// running the built Main bundle, and streams a long markdown answer from a local
// OpenAI-compatible fixture. It reads window.__olaStreamingPerf.snapshot() over CDP.
//
// Read-only with respect to the repo: no source, gate or config is modified.
// Run from the repo root:  node docs/qa/2026-11-13-streaming-profiler-probe.mjs

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const { createServer: createViteServer } = await import('vite')

const root = process.cwd()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A long answer with the constructs that actually cost render time: headings,
// prose, a fenced TS block (syntax highlighter), a list and a table.
const paragraphs = Array.from({ length: 14 }, (_, i) =>
  [
    `## 段落 ${i + 1}`,
    '',
    `这是第 ${i + 1} 段流式回答，用于测量 MessageList 在长回答下的 React commit 成本。`,
    '渲染管线需要同时处理 markdown 解析、代码高亮与虚拟滚动，因此每一帧的提交耗时都值得记录。',
    '',
    '```ts',
    `export function sample${i}(input: number): number {`,
    '  const doubled = input * 2',
    '  return doubled + 1',
    '}',
    '```',
    '',
    `- 要点 ${i + 1}.1：流式增量必须合并提交`,
    `- 要点 ${i + 1}.2：长代码块走高亮懒加载`,
    '',
    '| 列 A | 列 B |',
    '| --- | --- |',
    `| ${i} | ${i * 2} |`,
    ''
  ].join('\n')
)
const SENTINEL = 'OLA_STREAMING_PROBE_DONE'
const longReply = `${paragraphs.join('\n')}\n\n${SENTINEL}\n`

// Chunk roughly the way a real provider does: small pieces, short gaps.
const chunks = []
for (let i = 0; i < longReply.length; i += 48) chunks.push(longReply.slice(i, i + 48))

const prompt = 'Streaming profiler probe: please answer at length.'
const modelTranscript = []
const fixture = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  if (path !== '/v1/chat/completions') {
    response.writeHead(404).end()
    return
  }
  let body = ''
  request.setEncoding('utf8')
  request.on('data', (c) => {
    body += c
  })
  request.on('end', () => {
    modelTranscript.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    let index = 0
    const pump = () => {
      if (index >= chunks.length) {
        response.end('data: [DONE]\n\n')
        return
      }
      const delta = chunks[index++]
      response.write(`data: {"choices":[{"delta":{"content":${JSON.stringify(delta)}}}]}\n\n`)
      setTimeout(pump, 10)
    }
    pump()
  })
})
await new Promise((r) => fixture.listen(0, '127.0.0.1', r))
const fixturePort = fixture.address().port

const dataRoot = mkdtempSync(join(tmpdir(), 'ola-streaming-probe-'))
writeFileSync(join(dataRoot, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
mkdirSync(join(dataRoot, 'electron-user-data'), { recursive: true })
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
            id: 'probe-provider',
            name: 'Probe Provider',
            type: 'openai-chat',
            apiKey: '',
            baseUrl: `http://127.0.0.1:${fixturePort}/v1`,
            enabled: true,
            requiresApiKey: false,
            createdAt: Date.now(),
            models: [{ id: 'probe-model', name: 'Probe Model', enabled: true, category: 'chat' }]
          }
        ],
        activeProviderId: 'probe-provider',
        activeModelId: 'probe-model'
      },
      version: 0
    }
  })
)

// Reuse the repo's real renderer config so aliases, React and Tailwind plugins and
// the dev CSP are exactly what `npm run dev` would serve.
const configModule = await import(pathToFileURL(resolve(root, 'electron.vite.config.ts')).href)
const rendererConfig = configModule.default.renderer
const vite = await createViteServer({
  ...rendererConfig,
  root: resolve(root, 'src/renderer'),
  configFile: false,
  server: { ...rendererConfig.server, port: 5173, strictPort: true },
  logLevel: 'warn'
})
await vite.listen()
const rendererUrl = `http://localhost:5173/`

const debugPort = 9333
const electronBinary = require('electron')
const spawnedAt = Date.now()
const child = spawn(
  electronBinary,
  [
    join(root, 'out/main/index.js'),
    '--no-sandbox',
    '--disable-gpu',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${join(dataRoot, 'electron-user-data')}`
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      OLA_E2E_DATA_ROOT: dataRoot,
      ELECTRON_RENDERER_URL: rendererUrl
    },
    stdio: ['ignore', 'pipe', 'pipe']
  }
)
let mainLog = ''
child.stdout.on('data', (c) => {
  mainLog += c.toString()
})
child.stderr.on('data', (c) => {
  mainLog += c.toString()
})

function cdp(ws, method, params = {}) {
  return new Promise((resolvePromise, reject) => {
    const id = Math.floor(Math.random() * 1_000_000_000)
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString())
      if (message.id !== id) return
      ws.off('message', onMessage)
      if (message.error) reject(new Error(`${method}: ${message.error.message}`))
      else resolvePromise(message.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function waitForTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json`)
      if (response.ok) {
        const targets = await response.json()
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        if (page) return page
      }
    } catch {
      // Electron is still booting.
    }
    await sleep(500)
  }
  throw new Error('Timed out waiting for the Electron page target')
}

async function waitFor(ws, expression, description, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    const result = await cdp(ws, 'Runtime.evaluate', {
      expression: `(() => { try { return Boolean(${expression}) } catch (e) { return String(e) } })()`,
      returnByValue: true
    })
    last = result.result?.value
    if (last === true) return
    if (Date.now() >= deadline) break
    await sleep(250)
  }
  const page = await cdp(ws, 'Runtime.evaluate', {
    expression: `({ hash: location.hash, tail: document.body?.innerText?.slice(-500) ?? '' })`,
    returnByValue: true
  })
  throw new Error(
    `Timed out waiting for ${description}: ${JSON.stringify({
      last,
      modelRequests: modelTranscript.length,
      page: page.result?.value,
      mainLogTail: mainLog.slice(-1200)
    })}`
  )
}

const evidenceDir = resolve(root, 'docs/qa/assets')
mkdirSync(evidenceDir, { recursive: true })
const stamp = new Date().toISOString().slice(0, 10)
let ws
let exitCode = 1

try {
  const target = await waitForTarget()
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => {
    ws.once('open', r)
    ws.once('error', j)
  })
  await cdp(ws, 'Runtime.enable')
  await cdp(ws, 'Page.enable')

  await waitFor(
    ws,
    `document.querySelector('[role="textbox"][contenteditable="true"]')`,
    'the home composer to mount',
    60000
  )

  // The monitor must be installed, otherwise every number below would be a fake zero.
  // Runtime.evaluate runs as a classic script, so `import.meta` is not available here;
  // the monitor's own presence is the signal that DEV gating passed.
  const monitor = await cdp(ws, 'Runtime.evaluate', {
    expression: `({ enabled: Boolean(window.__olaStreamingPerf), href: location.href })`,
    returnByValue: true
  })
  const monitorState = monitor.result?.value
  if (!monitorState?.enabled) {
    throw new Error(
      `The streaming perf monitor is not installed, so no Profiler data exists: ${JSON.stringify(monitorState)}`
    )
  }

  const focus = await cdp(ws, 'Runtime.evaluate', {
    expression: `(() => { const e = document.querySelector('[role="textbox"][contenteditable="true"]'); if (!e) return false; e.focus(); return document.activeElement === e })()`,
    returnByValue: true
  })
  if (focus.result?.value !== true) throw new Error('The composer is not editable')
  await cdp(ws, 'Input.insertText', { text: prompt })
  await waitFor(
    ws,
    `(() => { const b = document.querySelector('[data-tour="composer"] .composer-send') || document.querySelector('.composer-send'); return b && b.disabled === false })()`,
    'the send button to enable'
  )

  // Attribute the samples to this answer alone, not to boot and navigation.
  await cdp(ws, 'Runtime.evaluate', { expression: `window.__olaStreamingPerf.reset()` })
  const streamStartedAt = Date.now()
  // The enabled state can flicker while the composer's React state settles, so
  // report what the click actually saw instead of failing on a single attempt.
  const sendExpression = `(() => {
    const all = [...document.querySelectorAll('[data-tour="composer"] .composer-send, .composer-send')];
    const b = all.find((i) => !i.disabled) ?? all[0];
    if (!b) return { clicked: false, reason: 'no send button', count: all.length };
    if (b.disabled) return { clicked: false, reason: 'disabled', count: all.length, states: all.map((i) => i.disabled) };
    b.click();
    return { clicked: true, count: all.length };
  })()`
  let sendResult
  for (let attempt = 0; attempt < 20; attempt += 1) {
    sendResult = (
      await cdp(ws, 'Runtime.evaluate', { expression: sendExpression, returnByValue: true })
    ).result?.value
    if (sendResult?.clicked) break
    await sleep(400)
  }
  if (!sendResult?.clicked) {
    const composerState = await cdp(ws, 'Runtime.evaluate', {
      expression: `(() => { const e = document.querySelector('[role="textbox"][contenteditable="true"]'); return { text: e?.textContent?.slice(0, 120), active: document.activeElement === e, buttons: [...document.querySelectorAll('button')].slice(0, 25).map((b) => ({ cls: b.className?.toString().slice(0, 50), disabled: b.disabled, label: b.getAttribute('aria-label') })) } })()`,
      returnByValue: true
    })
    throw new Error(
      `Could not send the probe prompt: ${JSON.stringify({ sendResult, composer: composerState.result?.value })}`
    )
  }
  await cdp(ws, 'Runtime.evaluate', {
    expression: `(() => { const b = [...document.querySelectorAll('button')].find((i) => i.textContent?.includes('切换并继续') || i.textContent?.includes('Switch and continue')); b?.click(); return Boolean(b) })()`,
    returnByValue: true
  })

  await waitFor(
    ws,
    `document.body?.innerText?.includes(${JSON.stringify(SENTINEL)})`,
    'the long streamed answer to finish rendering',
    120000
  )
  const streamMs = Date.now() - streamStartedAt
  if (modelTranscript.length === 0) throw new Error('The fixture never received a model request')
  await sleep(800)

  const snapshot = await cdp(ws, 'Runtime.evaluate', {
    expression: `window.__olaStreamingPerf.snapshot()`,
    returnByValue: true
  })
  const perf = snapshot.result?.value
  if (!perf?.enabled) throw new Error('The snapshot reports the monitor as disabled')

  const commits = perf.samples.reactCommit.map((s) => s.durationMs).sort((a, b) => a - b)
  const pct = (ratio) =>
    commits.length === 0
      ? 0
      : commits[Math.min(commits.length - 1, Math.ceil(commits.length * ratio) - 1)]
  const result = {
    probe: 'streaming-profiler',
    date: stamp,
    rendererMode: 'vite-dev (import.meta.env.DEV=true)',
    mainBundle: 'out/main/index.js (built)',
    monitorInstalled: monitorState.enabled,
    replyBytes: Buffer.byteLength(longReply, 'utf8'),
    replyChunks: chunks.length,
    modelRequests: modelTranscript.length,
    streamWallClockMs: streamMs,
    electronReadyMs: Date.now() - spawnedAt,
    reactCommit: {
      count: commits.length,
      p50Ms: Number(pct(0.5).toFixed(2)),
      p95Ms: Number(pct(0.95).toFixed(2)),
      maxMs: Number((commits.at(-1) ?? 0).toFixed(2)),
      totalMs: Number(commits.reduce((t, n) => t + n, 0).toFixed(2))
    },
    summary: perf.summary,
    failures: perf.failures,
    sampleCounts: Object.fromEntries(
      Object.entries(perf.samples).map(([k, v]) => [k, v.length])
    )
  }

  const jsonPath = join(evidenceDir, `streaming-profiler-${stamp}.json`)
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result, null, 2))
  console.log(`\nevidence: ${jsonPath}`)
  exitCode = 0
} catch (error) {
  console.error(`[streaming-profiler] FAILED: ${error instanceof Error ? error.message : error}`)
  console.error(`main log tail:\n${mainLog.slice(-2000)}`)
  exitCode = 1
} finally {
  try {
    ws?.close()
  } catch {
    // already closed
  }
  child.kill('SIGKILL')
  await vite.close()
  fixture.close()
  rmSync(dataRoot, { recursive: true, force: true })
}

process.exit(exitCode)