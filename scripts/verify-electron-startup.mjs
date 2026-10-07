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

const child = spawn(
  electronBinary,
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

  const accountTrigger = await cdp(ws, 'Runtime.evaluate', {
    expression: `(() => { const trigger = Array.from(document.querySelectorAll('button')).find((item) => /未登录|Not signed in/i.test(item.textContent ?? '')); if (!trigger) return null; const rect = trigger.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })()`,
    returnByValue: true
  })
  const accountTriggerPosition = accountTrigger.result?.value
  if (!accountTriggerPosition) throw new Error('Could not find the account menu trigger')
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
    expression: `({ heading: document.querySelector('h1')?.textContent?.trim() ?? '', bodyTextLength: document.body?.innerText?.length ?? 0, bodyText: document.body?.innerText ?? '' })`,
    returnByValue: true
  })
  const accountPageValue = accountPage.result?.value
  if (
    !accountPageValue ||
    !/登录|sign in/i.test(accountPageValue.heading) ||
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
    expression: `(() => { const session = Array.from(document.querySelectorAll('button')).find((item) => item.classList.contains('group/session') && /New Conversation/.test(item.textContent ?? '')); if (!session) return false; session.click(); return true })()`,
    returnByValue: true
  })
  if (openConversation.result?.value !== true) {
    throw new Error('Could not open an existing conversation for the translate flow')
  }
  await sleep(600)
  const userMessageMenuPosition = await cdp(ws, 'Runtime.evaluate', {
    expression: `(() => { const messages = Array.from(document.querySelectorAll('[class~="group/user"]')); const message = messages.find((item) => item.textContent?.trim()); const button = message?.querySelector('button[aria-label="显示更多"], button[aria-label="Show more"]'); if (!button) return null; const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })()`,
    returnByValue: true
  })
  const userMessageMenuPoint = userMessageMenuPosition.result?.value
  if (!userMessageMenuPoint) {
    const userMessageState = await cdp(ws, 'Runtime.evaluate', {
      expression: `Array.from(document.querySelectorAll('[class~="group/user"]')).map((item) => ({ text: item.textContent?.trim()?.slice(0, 100), buttons: Array.from(item.querySelectorAll('button')).map((button) => button.getAttribute('aria-label')) }))`,
      returnByValue: true
    })
    throw new Error(
      `Could not open the user-message actions for the translate flow: ${JSON.stringify(userMessageState.result?.value)}`
    )
  }
  await clickAt(ws, userMessageMenuPoint.x, userMessageMenuPoint.y)
  await sleep(120)
  const sendToTranslate = await cdp(ws, 'Runtime.evaluate', {
    expression: `(() => { const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((candidate) => /^(翻译|Translate)$/.test(candidate.textContent?.trim() ?? '')); if (!item) return false; item.click(); return true })()`,
    returnByValue: true
  })
  if (sendToTranslate.result?.value !== true) {
    throw new Error('Could not open the translate page from a user message')
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

  const logPath = join(evidenceDir, `electron-startup-${evidenceDate}.txt`)
  writeFileSync(logPath, combinedLogs)
  console.log(
    JSON.stringify(
      {
        passed: true,
        title: page.title,
        url: page.url,
        bodyTextLength: page.bodyTextLength,
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
}
