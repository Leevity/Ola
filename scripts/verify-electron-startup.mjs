import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const root = process.cwd()
const port = 9250 + Math.floor(Math.random() * 100)
// The packaged harness already boots against a throwaway data root; the source
// harness has to match, otherwise this check reads and writes the real ~/.ola.
const dataRoot = mkdtempSync(join(tmpdir(), 'ola-electron-e2e-'))
const userDataDir = join(dataRoot, 'electron-user-data')
writeFileSync(join(dataRoot, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
// An isolated root is a brand-new install, so the app would stop on the
// onboarding screen; mark it completed to enter the workspace like a real user.
writeFileSync(
  join(dataRoot, 'settings.json'),
  JSON.stringify({
    'ola-settings': {
      state: { onboardingCompleted: true, onboardingCompletedAt: Date.now() },
      version: 29
    }
  }),
  'utf8'
)
// The translate step needs a real conversation, and a CI runner has no prior state,
// so the harness brings its own OpenAI-compatible fixture and points a provider at it.
const startupPrompt = 'E2E startup prompt: summarise this workspace in one line.'
const startupReply = 'E2E startup reply: the workspace is ready.'
const modelTranscript = []
const modelServer = createServer((request, response) => {
  const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  if (requestPath !== '/v1/chat/completions') {
    response.writeHead(404).end()
    return
  }
  let body = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => {
    body += chunk
  })
  request.on('end', () => {
    modelTranscript.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: {"choices":[{"delta":{"content":${JSON.stringify(startupReply)}}}]}\n\ndata: [DONE]\n\n`
    )
  })
})
await new Promise((resolveListen) => modelServer.listen(0, '127.0.0.1', resolveListen))
const modelAddress = modelServer.address()
if (!modelAddress || typeof modelAddress === 'string') {
  throw new Error('The model fixture server did not bind to a port')
}
writeFileSync(
  join(dataRoot, 'config.json'),
  JSON.stringify({
    'ola-providers': {
      state: {
        providers: [
          {
            id: 'e2e-startup-provider',
            name: 'E2E Startup Provider',
            type: 'openai-chat',
            apiKey: '',
            baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
            enabled: true,
            requiresApiKey: false,
            createdAt: Date.now(),
            models: [
              {
                id: 'e2e-startup-model',
                name: 'E2E Startup Model',
                enabled: true,
                category: 'chat'
              }
            ]
          }
        ],
        activeProviderId: 'e2e-startup-provider',
        activeModelId: 'e2e-startup-model'
      },
      version: 0
    }
  }),
  'utf8'
)
const evidenceDir = join(root, 'docs/migrations/ts-runtime/evidence')
const evidenceDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(new Date())
const screenshotPath = join(evidenceDir, `electron-startup-${evidenceDate}.png`)
mkdirSync(evidenceDir, { recursive: true })

// Resolve the Electron binary through the package entry point so the launcher
// works on every platform; spawning node_modules/.bin/electron by name fails on
// Windows because the extension-less shim is not executable there.
const electronBinary = require('electron')

const spawnedAt = Date.now()
const child = spawn(
  electronBinary,
  [
    root,
    '--no-sandbox',
    '--disable-gpu',
    // The suite runner keeps the window in the background; without these switches
    // Chromium throttles frames for an occluded window, so every enter/exit
    // animation freezes and coordinate clicks land on a half-moved panel.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`
  ],
  {
    cwd: root,
    env: { ...process.env, OLA_E2E_DATA_ROOT: dataRoot },
    stdio: ['ignore', 'pipe', 'pipe']
  }
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

async function pressEscape(ws) {
  for (const type of ['keyDown', 'keyUp']) {
    await cdp(ws, 'Input.dispatchKeyEvent', {
      type,
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 53
    })
  }
  await sleep(250)
}

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

async function clickAt(ws, x, y) {
  await cdp(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp(ws, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await cdp(ws, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
}

async function waitFor(ws, expression, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    const result = await cdp(ws, 'Runtime.evaluate', {
      expression: `(() => { try { return Boolean(${expression}) } catch (error) { return String(error) } })()`,
      returnByValue: true
    })
    last = result.result?.value
    if (last === true) return last
    if (Date.now() >= deadline) break
    await sleep(250)
  }
  const page = await cdp(ws, 'Runtime.evaluate', {
    expression: `({ hash: location.hash, title: document.title, tail: document.body?.innerText?.slice(-700) ?? '' })`,
    returnByValue: true
  })
  throw new Error(
    `Timed out waiting for ${description}: ${JSON.stringify({
      last,
      modelRequests: modelTranscript.length,
      page: page.result?.value,
      mainLogTail: `${stdout}${stderr}`.slice(-1500)
    })}`
  )
}

// Animation-driven UI (Framer Motion panels, Radix layers) only settles while the
// renderer keeps painting. An occluded or background window stops requestAnimationFrame,
// which leaves panels frozen mid-transition and swallows coordinate clicks, so record the
// frame health before every click and keep it in the failure diagnostics.
async function frameHealth(ws) {
  const result = await cdp(ws, 'Runtime.evaluate', {
    expression: `(async () => {
      const tick = await Promise.race([
        new Promise((resolve) => requestAnimationFrame(() => resolve('raf'))),
        new Promise((resolve) => setTimeout(() => resolve('starved'), 800)),
      ]);
      return { visibility: document.visibilityState, hasFocus: document.hasFocus(), tick };
    })()`,
    returnByValue: true,
    awaitPromise: true
  })
  return result.result?.value
}

function readSettingsRoutes() {
  const source = readFileSync(
    join(root, 'src/renderer/src/components/settings/settings-registry.ts'),
    'utf8'
  )
  const registrySource = source.slice(
    source.search(/export\s+const\s+SETTINGS_REGISTRY/),
    source.search(/const\s+pageById/)
  )
  const routes = []
  const pagePattern = /\{\s*id:\s*'([^']+)'[\s\S]*?section:\s*'([^']+)'[\s\S]*?\}/g
  for (const match of registrySource.matchAll(pagePattern)) {
    routes.push(`#/settings/${match[2]}/${match[1]}`)
  }
  if (routes.length === 0) throw new Error('Settings registry produced no routes')
  return routes
}

async function main() {
  let target
  try {
    target = await waitForTarget()
  } catch (error) {
    const details = [
      `Electron exit code: ${child.exitCode ?? 'still running'}`,
      stdout.trim() && `Electron stdout:\n${stdout.trim()}`,
      stderr.trim() && `Electron stderr:\n${stderr.trim()}`
    ]
      .filter(Boolean)
      .join('\n\n')
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${details}`)
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
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
  const targetReadyMs = Date.now() - spawnedAt
  // Cold-start evidence: poll for the first React commit instead of relying on the
  // fixed settle sleep below, which would otherwise dominate the number.
  let firstPaintMs = null
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = await cdp(ws, 'Runtime.evaluate', {
      expression: 'Boolean(document.querySelector("#root")?.firstElementChild)',
      returnByValue: true
    })
    if (probe.result?.value === true) {
      firstPaintMs = Date.now() - spawnedAt
      break
    }
    await sleep(100)
  }
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
  const initialBodyText = await cdp(ws, 'Runtime.evaluate', {
    expression: 'document.body?.innerText ?? ""',
    returnByValue: true
  }).then((result) => String(result.result?.value ?? ''))
  if (/minified react error|出了点问题/i.test(initialBodyText)) {
    await cdp(ws, 'Runtime.evaluate', {
      expression: `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('错误详情') || button.textContent?.includes('Error details'))?.click()`
    })
    await sleep(150)
    const details = await cdp(ws, 'Runtime.evaluate', {
      expression: 'document.body?.innerText ?? ""',
      returnByValue: true
    })
    throw new Error(
      `Renderer crashed during startup. Details: ${String(details.result?.value ?? initialBodyText)}; CDP: ${JSON.stringify(rendererErrors)}`
    )
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
        bodyText: document.body?.innerText ?? '',
        hasRoot: Boolean(document.querySelector('#root'))
      })`,
      returnByValue: true
    })
    const value = routeState.result?.value
    if (
      !value?.hasRoot ||
      value.bodyTextLength < 80 ||
      /minified react error|出了点问题/i.test(value.bodyText)
    ) {
      await cdp(ws, 'Runtime.evaluate', {
        expression: `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('错误详情') || button.textContent?.includes('Error details'))?.click()`
      })
      const details = await cdp(ws, 'Runtime.evaluate', {
        expression: 'document.body?.innerText ?? ""',
        returnByValue: true
      })
      throw new Error(
        `Route smoke failed for ${route}: ${String(details.result?.value ?? JSON.stringify(value))}; CDP: ${JSON.stringify(rendererErrors)}`
      )
    }
  }

  await cdp(ws, 'Runtime.evaluate', { expression: `window.location.hash = '#/'` })
  await sleep(350)

  const featureSurfaces = [
    {
      name: 'tasks',
      expectedTitle: /^(任务|Tasks)$/i,
      openExpression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => /^(任务与自动化|Tasks & automation)$/.test(item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`
    },
    ...[
      { name: 'resources', label: /^(资源|Resources)$/i },
      { name: 'draw', label: /^(绘图|Draw)$/i },
      { name: 'skills', label: /^(技能|Skills)$/i },
      { name: 'souls', label: /^SOUL$/i },
      { name: 'sync', label: /^(同步|Sync)$/i }
    ].map(({ name, label }) => ({
      name,
      expectedTitle: label,
      menuItemLabel: label,
      openExpression: `(() => { const trigger = Array.from(document.querySelectorAll('button')).find((item) => /^(扩展功能|Extensions)$/.test(item.textContent?.trim() ?? '')); if (!trigger) return false; trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return true })()`
    }))
  ]

  for (const surface of featureSurfaces) {
    const opened = await cdp(ws, 'Runtime.evaluate', {
      expression: surface.openExpression,
      returnByValue: true
    })
    if (opened.result?.value !== true) {
      const navigation = await cdp(ws, 'Runtime.evaluate', {
        expression: `({ url: location.href, body: document.body?.innerText?.slice(0, 800), navs: Array.from(document.querySelectorAll('nav')).map((nav) => ({ label: nav.getAttribute('aria-label'), buttons: Array.from(nav.querySelectorAll('button')).map((button) => ({ label: button.getAttribute('aria-label'), text: button.textContent?.trim() })) })) })`,
        returnByValue: true
      })
      throw new Error(
        `Could not open ${surface.name} from the application navigation: ${JSON.stringify(navigation.result?.value)}`
      )
    }
    if (surface.menuItemLabel) {
      await sleep(150)
      const selected = await cdp(ws, 'Runtime.evaluate', {
        expression: `(() => { const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((candidate) => ${surface.menuItemLabel}.test(candidate.textContent?.trim() ?? '')); if (!item) return false; item.click(); return true })()`,
        returnByValue: true
      })
      if (selected.result?.value !== true) {
        const menuState = await cdp(ws, 'Runtime.evaluate', {
          expression: `({ menus: Array.from(document.querySelectorAll('[role="menu"], [role="menuitem"]')).map((item) => ({ role: item.getAttribute('role'), text: item.textContent?.trim() })), body: document.body?.innerText?.slice(0, 500) })`,
          returnByValue: true
        })
        throw new Error(
          `Could not select ${surface.name} from the extensions menu: ${JSON.stringify(menuState.result?.value)}`
        )
      }
    }
    await sleep(700)
    const state = await cdp(ws, 'Runtime.evaluate', {
      expression: `({ title: document.querySelector('.workspace-titlebar-surface')?.textContent?.trim() ?? '', bodyTextLength: document.body?.innerText?.length ?? 0, bodyText: document.body?.innerText ?? '' })`,
      returnByValue: true
    })
    const value = state.result?.value
    if (
      !value ||
      !surface.expectedTitle.test(value.title) ||
      value.bodyTextLength < 80 ||
      /minified react error|出了点问题/i.test(value.bodyText)
    ) {
      throw new Error(`Feature surface smoke failed for ${surface.name}: ${JSON.stringify(value)}`)
    }
  }

  await cdp(ws, 'Runtime.evaluate', { expression: `window.location.hash = '#/usage'` })
  await sleep(250)
  await cdp(ws, 'Runtime.evaluate', { expression: `window.location.hash = '#/'` })
  await sleep(350)
  // A surface visited earlier in the flow can leave an overlay mounted, which then
  // swallows the coordinate click below.
  await pressEscape(ws)

  const accountTrigger = await cdp(ws, 'Runtime.evaluate', {
    expression: `(() => { const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }; const chain = (el) => { const out = []; let node = el; for (let i = 0; i < 5 && node; i += 1) { out.push({ tag: node.tagName, label: node.getAttribute('aria-label') || node.id || node.className?.toString().slice(0, 70), pointerEvents: getComputedStyle(node).pointerEvents, z: getComputedStyle(node).zIndex, position: getComputedStyle(node).position }); node = node.parentElement } return out }; const trigger = Array.from(document.querySelectorAll('button')).find((item) => /未登录|Not signed in/i.test(item.textContent ?? '')); if (!trigger) return null; trigger.scrollIntoView({ block: 'center' }); const rect = trigger.getBoundingClientRect(); const x = rect.x + rect.width / 2; const y = rect.y + rect.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, triggerBox: box(trigger), viewport: [innerWidth, innerHeight], hit: hit === trigger || trigger.contains(hit) ? 'trigger' : (hit?.getAttribute('aria-label') || hit?.id || hit?.className?.toString().slice(0, 80) || 'none'), hitBox: hit && hit !== trigger ? box(hit) : undefined, hitChain: hit ? chain(hit) : [], sidebarBox: box(document.querySelector('[class*="sidebar" i]') ?? document.body) } })()`,
    returnByValue: true
  })
  const accountTriggerPosition = accountTrigger.result?.value
  if (!accountTriggerPosition) throw new Error('Could not find the account menu trigger')
  if (accountTriggerPosition.hit !== 'trigger') {
    throw new Error(
      `Account menu trigger is not clickable: ${JSON.stringify({
        frameHealth: await frameHealth(ws),
        trigger: accountTriggerPosition
      })}`
    )
  }
  await clickAt(ws, accountTriggerPosition.x, accountTriggerPosition.y)
  await sleep(150)
  const openAccountAuth = await cdp(ws, 'Runtime.evaluate', {
    expression: `(() => { const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((candidate) => /^(登录 Ola|Sign in to Ola)$/.test(candidate.textContent?.trim() ?? '')); if (!item) return false; item.click(); return true })()`,
    returnByValue: true
  })
  if (openAccountAuth.result?.value !== true) {
    const menuState = await cdp(ws, 'Runtime.evaluate', {
      expression: `({ items: Array.from(document.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim()), body: document.body?.innerText?.slice(-500) })`,
      returnByValue: true
    })
    throw new Error(`Could not open account sign-in: ${JSON.stringify(menuState.result?.value)}`)
  }
  await sleep(500)
  const accountPage = await cdp(ws, 'Runtime.evaluate', {
    expression: `({ heading: document.querySelector('h1')?.textContent?.trim() ?? '', signInTitle: document.querySelector('#ola-sign-in-title')?.textContent?.trim() ?? '', bodyTextLength: document.body?.innerText?.length ?? 0, bodyText: document.body?.innerText ?? '' })`,
    returnByValue: true
  })
  const accountPageValue = accountPage.result?.value
  if (
    !accountPageValue ||
    !/登录|sign in/i.test(accountPageValue.signInTitle) ||
    accountPageValue.bodyTextLength < 80 ||
    /minified react error|出了点问题/i.test(accountPageValue.bodyText)
  ) {
    throw new Error(`Account sign-in page smoke failed: ${JSON.stringify(accountPageValue)}`)
  }
  const closeAccountAuth = await cdp(ws, 'Runtime.evaluate', {
    expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => /^(返回 Ola|后退|返回|Back(?: to Ola)?)$/i.test(item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
    returnByValue: true
  })
  if (closeAccountAuth.result?.value !== true)
    throw new Error('Could not return from account sign-in')
  await sleep(350)

  const openConversation = await cdp(ws, 'Runtime.evaluate', {
    expression: `(() => { const editor = document.querySelector('[role="textbox"][contenteditable="true"]'); if (!editor) return false; editor.focus(); return document.activeElement === editor })()`,
    returnByValue: true
  })
  if (openConversation.result?.value !== true) {
    throw new Error(
      'The home composer is not editable, so the translate flow cannot create its own conversation'
    )
  }
  await cdp(ws, 'Input.insertText', { text: startupPrompt })
  await waitFor(
    ws,
    `(() => { const button = document.querySelector('[data-tour="composer"] .composer-send') || document.querySelector('.composer-send'); return button && button.disabled === false })()`,
    'the composer send button to enable',
    10_000
  )
  const sendStartupPrompt = await cdp(ws, 'Runtime.evaluate', {
    expression: `(() => { const button = document.querySelector('[data-tour="composer"] .composer-send') || document.querySelector('.composer-send'); if (!button || button.disabled) return false; button.click(); return true })()`,
    returnByValue: true
  })
  if (sendStartupPrompt.result?.value !== true) {
    throw new Error('Could not send the startup prompt through the composer')
  }
  // A template-backed prompt can ask to switch the execution mode before running.
  await cdp(ws, 'Runtime.evaluate', {
    expression: `(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('切换并继续') || item.textContent?.includes('Switch and continue')); button?.click(); return Boolean(button) })()`,
    returnByValue: true
  })
  await waitFor(
    ws,
    `document.body?.innerText?.includes(${JSON.stringify(startupPrompt)})`,
    'the startup prompt to render as a user message'
  )
  await waitFor(
    ws,
    `document.body?.innerText?.includes(${JSON.stringify(startupReply)})`,
    'the fixture model response to render',
    45_000
  )
  if (modelTranscript.length === 0) {
    throw new Error('The fixture provider never received a model request for the startup prompt')
  }
  await sleep(600)
  // The runtime status panel opens by default and floats over the top-right of the
  // conversation, which is exactly where the hover-revealed message toolbar lives.
  // Escape is the supported close gesture, so the flow below gets a deterministic UI.
  await pressEscape(ws)
  // The message toolbar only renders inside the scroll viewport; without this the
  // button sits at a negative y and the synthesized click lands on nothing.
  const moreButtonProbe = `(() => { const messages = Array.from(document.querySelectorAll('[class~="group/user"]')); const message = messages.find((item) => item.textContent?.trim()); const button = message?.querySelector('button[aria-label="显示更多"], button[aria-label="Show more"]'); if (!button) return null; const rect = button.getBoundingClientRect(); const x = rect.x + rect.width / 2; const y = rect.y + rect.height / 2; const hit = document.elementFromPoint(x, y); const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }; return { x, y, buttonBox: box(button), buttonStyle: { position: getComputedStyle(button).position, zIndex: getComputedStyle(button).zIndex, opacity: getComputedStyle(button.closest('div[class*="opacity-0"]') ?? button).opacity }, scrollable: (message?.closest('[class*="overflow-y"]')?.scrollTop ?? -1).toFixed(0), hit: hit === button || button.contains(hit) ? 'trigger' : (hit?.getAttribute('aria-label') || hit?.className?.toString().slice(0, 60) || 'none'), hitBox: hit && hit !== button ? box(hit) : undefined, hitTag: hit?.tagName, hitParent: hit?.parentElement?.className?.toString().slice(0, 60) } })()`
  const scrollingProbe = `(() => { const messages = Array.from(document.querySelectorAll('[class~="group/user"]')); const message = messages.find((item) => item.textContent?.trim()); const button = message?.querySelector('button[aria-label="显示更多"], button[aria-label="Show more"]'); if (!button) return false; button.scrollIntoView({ block: 'center' }); return true })()`
  if (
    (await cdp(ws, 'Runtime.evaluate', { expression: scrollingProbe, returnByValue: true })).result
      ?.value !== true
  ) {
    const userMessageState = await cdp(ws, 'Runtime.evaluate', {
      expression: `Array.from(document.querySelectorAll('[class~="group/user"]')).map((item) => ({ text: item.textContent?.trim()?.slice(0, 100), buttons: Array.from(item.querySelectorAll('button')).map((button) => button.getAttribute('aria-label')) }))`,
      returnByValue: true
    })
    throw new Error(
      `Could not open the user-message actions for the translate flow: ${JSON.stringify(userMessageState.result?.value)}`
    )
  }
  // scrollIntoView does not commit in the same task, so the rect is only trustworthy
  // after the scroll has settled; clicking the pre-scroll point hits whatever was
  // under the viewport centre and the menu never opens.
  await sleep(300)
  const userMessageMenuPoint = (
    await cdp(ws, 'Runtime.evaluate', { expression: moreButtonProbe, returnByValue: true })
  ).result?.value
  if (!userMessageMenuPoint) {
    throw new Error('The user-message more button disappeared after scrolling')
  }
  if (userMessageMenuPoint.hit !== 'trigger') {
    throw new Error(
      `User-message more button is not clickable: ${JSON.stringify(userMessageMenuPoint)}`
    )
  }
  await clickAt(ws, userMessageMenuPoint.x, userMessageMenuPoint.y)
  await sleep(200)
  const sendToTranslate = await cdp(ws, 'Runtime.evaluate', {
    expression: `(() => { const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((candidate) => /^(翻译|Translate)$/.test(candidate.textContent?.trim() ?? '')); if (!item) return false; item.click(); return true })()`,
    returnByValue: true
  })
  if (sendToTranslate.result?.value !== true) {
    const menuState = await cdp(ws, 'Runtime.evaluate', {
      expression: `({ locale: document.documentElement.lang || navigator.language, menuRoots: document.querySelectorAll('[role="menu"]').length, items: Array.from(document.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim()?.slice(0, 40)), overlays: Array.from(document.querySelectorAll('[data-radix-popper-content-wrapper],[role="dialog"]')).length, hash: window.location.hash })`,
      returnByValue: true
    })
    throw new Error(
      `Could not open the translate page from a user message: ${JSON.stringify(menuState.result?.value)}`
    )
  }
  await sleep(500)
  const translatePage = await cdp(ws, 'Runtime.evaluate', {
    expression: `({ title: document.querySelector('.workspace-titlebar-surface')?.textContent?.trim() ?? '', bodyTextLength: document.body?.innerText?.length ?? 0, bodyText: document.body?.innerText ?? '' })`,
    returnByValue: true
  })
  const translatePageValue = translatePage.result?.value
  if (
    !translatePageValue ||
    !/(翻译|Translate)$/i.test(translatePageValue.title) ||
    translatePageValue.bodyTextLength < 80 ||
    /minified react error|出了点问题/i.test(translatePageValue.bodyText)
  ) {
    throw new Error(`Translate workflow smoke failed: ${JSON.stringify(translatePageValue)}`)
  }

  await cdp(ws, 'Runtime.evaluate', { expression: `window.location.hash = '#/usage'` })
  await sleep(250)
  await cdp(ws, 'Runtime.evaluate', { expression: `window.location.hash = '#/'` })
  await sleep(350)
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const transientNotice = await cdp(ws, 'Runtime.evaluate', {
      expression: `Array.from(document.querySelectorAll('[data-sonner-toast], [role="status"], [role="alert"]')).some((item) => /翻译页|translate page/i.test(item.textContent ?? ''))`,
      returnByValue: true
    })
    if (!transientNotice.result?.value) break
    await sleep(200)
  }

  const screenshot = await cdp(ws, 'Page.captureScreenshot', { format: 'png' })
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  ws.close()

  const combinedLogs = `${stdout}\n${stderr}`
  const unexpectedRendererErrors = rendererErrors.filter((error) => {
    const value = typeof error === 'string' ? error : JSON.stringify(error)
    return (
      !value.includes('Electron sandboxed_renderer.bundle.js') &&
      !value.includes("Cannot destructure property 'preloadScripts'")
    )
  })
  if (unexpectedRendererErrors.length > 0) {
    throw new Error(`Renderer reported runtime errors: ${JSON.stringify(unexpectedRendererErrors)}`)
  }
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

  // The window opens even when the runtime child never starts, so a forbidden
  // pattern list cannot prove isolation. Require the positive marker instead:
  // a misresolved or stale child bundle must turn this gate red.
  const isolatedReady = combinedLogs.match(/\[TsRuntime\] isolated runtime ready \(pid (\d+)\)/)
  if (!isolatedReady) {
    throw new Error(
      'Electron startup never reported an isolated runtime child; the utilityProcess path was not exercised'
    )
  }

  const logPath = join(evidenceDir, `electron-startup-${evidenceDate}.txt`)
  writeFileSync(logPath, combinedLogs)
  console.log(
    JSON.stringify(
      {
        passed: true,
        title: page.title,
        url: page.url,
        bodyTextLength: page.bodyTextLength,
        targetReadyMs,
        firstPaintMs,
        isolatedRuntimePid: Number(isolatedReady[1]),
        routeCount: routes.length,
        featureSurfaceCount: featureSurfaces.length,
        accountAuthChecked: true,
        translateFlowChecked: true,
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
  modelServer.closeAllConnections()
  modelServer.close()
}
