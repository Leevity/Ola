import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const electron = require('electron')
const directory = resolve(fileURLToPath(new URL('.', import.meta.url)))
const project = resolve(directory, '../../..')
const root = await mkdtemp(join(tmpdir(), 'ola-security-ui-audit-'))
const port = 11000 + Math.floor(Math.random() * 40000)
let child
let socket
let logs = ''
let probeServer
let probeRequests = 0

/** @returns {Promise<any>} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function call(method, params = {}) {
  const id = Math.floor(Math.random() * 1e9)
  return await new Promise((resolveCall, reject) => {
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    const onMessage = (raw) => {
      const response = JSON.parse(String(raw))
      if (response.id !== id) return
      socket.off('message', onMessage)
      if (response.error) reject(new Error(`${method}: ${response.error.message}`))
      else resolveCall(response.result)
    }
    socket.on('message', onMessage)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

/** @returns {Promise<any>} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result?.value
}

/** @returns {Promise<void>} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function capture(name) {
  const result = await call('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false
  })
  await writeFile(join(directory, name), Buffer.from(result.data, 'base64'))
  const metrics = await evaluate(
    `({hash:location.hash,width:innerWidth,height:innerHeight,bodyWidth:document.body.scrollWidth,bodyHeight:document.body.scrollHeight,buttons:[...document.querySelectorAll('button')].length,headings:[...document.querySelectorAll('h1,h2,h3')].map(e=>e.textContent.trim()).slice(0,30),text:document.body.innerText.slice(0,1800)})`
  )
  await writeFile(join(directory, `${name}.json`), JSON.stringify(metrics, null, 2))
}

try {
  await mkdir(directory, { recursive: true })
  await writeFile(join(root, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
  await writeFile(
    join(root, 'settings.json'),
    JSON.stringify({
      'ola-settings': {
        state: { onboardingCompleted: true, onboardingCompletedAt: Date.now(), language: 'zh' },
        version: 29
      }
    })
  )
  child = spawn(
    electron,
    [
      join(project, 'out/main/index.js'),
      '--no-sandbox',
      '--disable-gpu',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${join(root, 'electron-user-data')}`
    ],
    {
      cwd: project,
      env: { ...process.env, OLA_E2E_DATA_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  child.stdout.on('data', (chunk) => {
    logs += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    logs += String(chunk)
  })
  let target
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      const targets = await response.json()
      target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target) break
    } catch {
      /* starting */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  if (!target) throw new Error(`Renderer unavailable: ${logs.slice(-4000)}`)
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await once(socket, 'open')
  await call('Runtime.enable')
  await call('Page.enable')
  for (let i = 0; i < 80; i++) {
    const ready = await evaluate(`document.querySelector('#root')?.textContent?.length > 20`)
    if (ready) break
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  await capture('01-workspace.png')
  const routes = [
    ['02-settings-general.png', '#/settings/common/general'],
    ['03-settings-permission.png', '#/settings/execution/permission'],
    ['04-settings-integrations.png', '#/settings/integrations/plugin'],
    ['05-settings-narrow.png', '#/settings/common/general']
  ]
  for (const [name, route] of routes) {
    if (name.includes('narrow')) await evaluate('window.resizeTo(900,600)')
    await evaluate(`location.hash=${JSON.stringify(route)}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 850))
    await capture(name)
    if (name.includes('integrations')) {
      const keyboardProbe = await evaluate(`(async () => {
        const tablist = [...document.querySelectorAll('[role="tablist"]')].find((list) => list.querySelectorAll('[role="tab"]').length === 2)
        const active = tablist?.querySelector('[role="tab"][aria-selected="true"]')
        active?.focus()
        active?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
        for (let attempt = 0; attempt < 15; attempt++) {
          if (tablist?.querySelector('[role="tab"][aria-selected="true"]')?.id !== active?.id) break
          await new Promise((resolveWait) => setTimeout(resolveWait, 50))
        }
        const selected = tablist?.querySelector('[role="tab"][aria-selected="true"]')
        const linkedPanel = selected?.getAttribute('aria-controls')
        const panel = linkedPanel ? document.getElementById(linkedPanel) : null
        const rovingTabStops = tablist ? [...tablist.querySelectorAll('[role="tab"]')].filter((tab) => tab.tabIndex === 0).length : 0
        const result = {
          selected: selected?.id ?? null,
          focused: document.activeElement?.id ?? null,
          panelLinked: Boolean(panel && panel.getAttribute('aria-labelledby') === selected?.id),
          rovingTabStops
        }
        selected?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
        return result
      })()`)
      if (
        !keyboardProbe.panelLinked ||
        keyboardProbe.rovingTabStops !== 1 ||
        keyboardProbe.selected === 'capability-tab-builtin' ||
        !keyboardProbe.focused?.endsWith('custom')
      ) {
        throw new Error(`Capability tab keyboard probe failed: ${JSON.stringify(keyboardProbe)}`)
      }
      await writeFile(
        join(directory, 'capability-tab-keyboard-probe.json'),
        JSON.stringify(keyboardProbe, null, 2)
      )
    }
  }
  probeServer = createServer((_request, response) => {
    probeRequests += 1
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(
      '<!doctype html><title>Local navigation probe</title><main>Local navigation probe</main>'
    )
  })
  await new Promise((resolveListen) => probeServer.listen(0, '127.0.0.1', resolveListen))
  const address = probeServer.address()
  const originalUrl = await evaluate('location.href')
  await evaluate(`location.href='http://127.0.0.1:${address.port}/'`)
  let probe = null
  for (let i = 0; i < 40; i++) {
    try {
      probe = await evaluate(
        `({url:location.href,preload:typeof window.ola,unrestrictedIpc:typeof window.electron?.ipcRenderer?.invoke})`
      )
      if (probe.url === originalUrl) break
    } catch {
      /* navigation in progress */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  probe = { ...probe, navigationBlocked: probe?.url === originalUrl, probeRequests }
  if (!probe.navigationBlocked || probe.unrestrictedIpc !== 'undefined' || probeRequests !== 0) {
    throw new Error(`Renderer navigation security probe failed: ${JSON.stringify(probe)}`)
  }
  await writeFile(join(directory, 'security-navigation-probe.json'), JSON.stringify(probe, null, 2))
  console.log(JSON.stringify({ directory, screenshots: routes.length + 1 }))
} finally {
  socket?.close()
  if (probeServer) await new Promise((resolveClose) => probeServer.close(resolveClose))
  if (child && !child.killed) {
    child.kill('SIGTERM')
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolveWait) => setTimeout(resolveWait, 2000))
    ])
  }
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
