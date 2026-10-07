import { once } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const electronBinary = require('electron') as string
const WebSocket = require('ws') as {
  new (url: string): DevToolsSocket
}
const enabled = process.env.RUN_RESOURCES_COMMAND_ELECTRON_E2E === '1'

type DevToolsSocket = {
  close(): void
  on(event: 'message', listener: (raw: Buffer | string) => void): void
  off(event: 'message', listener: (raw: Buffer | string) => void): void
  send(data: string): void
  once(event: 'open', listener: () => void): void
}

let root: string | undefined
let child: ChildProcess | undefined
let socket: DevToolsSocket | undefined
let logs = ''

async function call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!socket) throw new Error('Electron DevTools connection is not open')
  const target = socket
  const id = Math.floor(Math.random() * 1_000_000_000)
  return new Promise((resolveCall, reject) => {
    const timer = setTimeout(() => {
      target.off('message', onMessage)
      reject(new Error(`Timed out waiting for ${method}`))
    }, 12_000)
    const onMessage = (raw: Buffer | string): void => {
      const message = JSON.parse(raw.toString()) as {
        id?: number
        error?: { message: string }
        result?: unknown
      }
      if (message.id !== id) return
      clearTimeout(timer)
      target.off('message', onMessage)
      if (message.error) reject(new Error(`${method}: ${message.error.message}`))
      else resolveCall((message.result ?? {}) as T)
    }
    target.on('message', onMessage)
    target.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate<T>(expression: string): Promise<T | undefined> {
  const response = await call<{ result?: { value?: T } }>('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  return response.result?.value
}

async function saveScreenshot(path: string): Promise<void> {
  const screenshot = await call<{ data?: string }>('Page.captureScreenshot', { format: 'png' })
  if (!screenshot.data) throw new Error('Resource page screenshot data is missing')
  await writeFile(path, Buffer.from(screenshot.data, 'base64'))
}

async function waitFor<T>(
  expression: string,
  predicate: (value: T | undefined) => boolean,
  description: string
): Promise<T> {
  let last: T | undefined
  for (let attempt = 0; attempt < 80; attempt += 1) {
    last = await evaluate<T>(expression)
    if (predicate(last)) return last as T
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  const page = await evaluate(`document.body.innerText.slice(-800)`)
  throw new Error(
    `Timed out waiting for ${description}; last=${JSON.stringify(last)}; page=${JSON.stringify(page)}; logs=${logs.slice(-2000)}`
  )
}

async function clickText(selector: string, label: string): Promise<void> {
  const point = await waitFor<{ x: number; y: number }>(
    `(() => { const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find((entry) => entry.textContent?.trim() === ${JSON.stringify(label)}); if (!node) return null; node.scrollIntoView({ block: 'center' }); const rect = node.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`,
    Boolean,
    `${label} control`
  )
  for (const type of ['mousePressed', 'mouseReleased']) {
    await call('Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1
    })
  }
}

async function connect(port: number): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      if (response.ok) {
        const pages = (await response.json()) as Array<{
          type: string
          url?: string
          webSocketDebuggerUrl?: string
        }>
        const page = pages.find(
          (entry) =>
            entry.type === 'page' &&
            entry.url?.includes('layoutWindowScope=primary') &&
            entry.webSocketDebuggerUrl
        )
        if (page?.webSocketDebuggerUrl) {
          socket = new WebSocket(page.webSocketDebuggerUrl)
          await new Promise<void>((resolveOpen) => socket!.once('open', resolveOpen))
          await call('Runtime.enable')
          return
        }
      }
    } catch {
      // Main and Renderer may still be starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`Timed out waiting for the primary page; logs=${logs.slice(-3000)}`)
}

async function stopApp(): Promise<void> {
  socket?.close()
  socket = undefined
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000))
    ])
  }
  child = undefined
}

async function startApp(): Promise<void> {
  if (!root) throw new Error('Missing isolated E2E root')
  const port = 12_000 + Math.floor(Math.random() * 35_000)
  const packagedExe = process.env.OLA_PACKAGED_EXE
  child = spawn(
    packagedExe ?? electronBinary,
    [
      ...(packagedExe ? [] : [join(process.cwd(), 'out/main/index.js')]),
      '--no-sandbox',
      '--disable-gpu',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${join(root, 'electron-user-data')}`
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, OLA_E2E_DATA_ROOT: root, OLA_STRICT_IPC_ALLOWLIST: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  child.stdout?.on('data', (chunk: Buffer) => (logs += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (logs += chunk.toString()))
  await connect(port)
  await waitFor<boolean>(
    `Boolean([...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === '扩展功能'))`,
    Boolean,
    'the workspace sidebar'
  )
}

async function openResources(): Promise<void> {
  await clickText('button', '扩展功能')
  await clickText('[role="menuitem"]', '资源')
  await waitFor<boolean>(
    `Boolean([...document.querySelectorAll('h1')].find((heading) => heading.textContent?.trim() === '资源'))`,
    Boolean,
    'the resources page'
  )
}

async function prepareRoot(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'ola-resources-command-electron-'))
  await writeFile(join(root, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n', 'utf8')
  await writeFile(
    join(root, 'settings.json'),
    JSON.stringify({
      'ola-settings': {
        state: { onboardingCompleted: true, onboardingCompletedAt: Date.now() },
        version: 29
      }
    }),
    'utf8'
  )
}

afterEach(async () => {
  await stopApp()
  logs = ''
  delete process.env.OLA_E2E_COMMANDS_MANAGE_LIST_FAIL_ONCE
  delete process.env.OLA_E2E_COMMANDS_MANAGE_READ_FAIL_ONCE
  if (root) {
    const target = resolve(root)
    if (!target.startsWith(resolve(tmpdir()) + sep)) {
      throw new Error('Refusing to remove a non-temporary E2E root')
    }
    await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
  root = undefined
})

describe.skipIf(!enabled)('resources command workflow in Electron', () => {
  it('creates, edits, saves, and reloads a user command through the page', async () => {
    await prepareRoot()
    await startApp()
    await openResources()
    const labels = await evaluate<string>(`document.querySelector('[role="tablist"]')?.innerText`)
    expect(labels).toContain('工作')
    expect(labels).toContain('编程')
    expect(labels).not.toContain('Work 工作')
    expect(
      await evaluate<boolean>(
        `Boolean(document.querySelector('input[aria-label="搜索名称、摘要或路径"]'))`
      )
    ).toBe(true)

    const commandsButton = await waitFor<boolean>(
      `Boolean([...document.querySelectorAll('button')].find((button) => button.querySelector('span')?.textContent?.trim() === '命令'))`,
      Boolean,
      'the localized Commands category'
    )
    expect(commandsButton).toBe(true)
    await evaluate(
      `[...document.querySelectorAll('button')].find((button) => button.querySelector('span')?.textContent?.trim() === '命令')?.click()`
    )
    await clickText('button', '新增命令')
    await waitFor<boolean>(
      `Boolean(document.querySelector('#resource-command-name') && document.querySelector('label[for="resource-command-name"]'))`,
      Boolean,
      'the named command field'
    )
    await evaluate(`document.querySelector('#resource-command-name')?.focus()`)
    await call('Input.insertText', { text: 'Invalid Name' })
    await clickText('[role="dialog"] button', '创建')
    await waitFor<boolean>(
      `document.body.innerText.includes('命令名只能包含小写字母、数字和连字符。')`,
      Boolean,
      'localized command name validation'
    )
    await evaluate(`document.querySelector('#resource-command-name')?.select()`)
    await call('Input.insertText', { text: 'release-check-e2e' })
    await clickText('[role="dialog"] button', '创建')
    await waitFor<boolean>(
      `Boolean(document.querySelector('textarea[aria-label="资源内容"]'))`,
      Boolean,
      'the new command editor'
    )
    await evaluate(`document.querySelector('textarea[aria-label="资源内容"]')?.focus()`)
    await evaluate(`document.querySelector('textarea[aria-label="资源内容"]')?.select()`)
    await call('Input.insertText', { text: '# Release check E2E\n\nPersisted command content.' })
    await evaluate(`document.querySelector('button[aria-label="保存资源"]')?.click()`)
    await waitFor<boolean>(
      `document.body.innerText.includes('已保存') && !document.querySelector('textarea[aria-label="资源内容"]')`,
      Boolean,
      'saved command preview'
    )
    if (!root) throw new Error('Missing isolated E2E root')
    const commandPath = join(root, 'commands', 'release-check-e2e.md')
    expect(await readFile(commandPath, 'utf8')).toContain('Persisted command content.')

    await stopApp()
    await startApp()
    await openResources()
    await evaluate(
      `[...document.querySelectorAll('button')].find((button) => button.querySelector('span')?.textContent?.trim() === '命令')?.click()`
    )
    await waitFor<boolean>(
      `document.body.innerText.includes('release-check-e2e')`,
      Boolean,
      'the persisted command in the resources page after restart'
    )
    await evaluate(
      `[...document.querySelectorAll('button')].find((button) => button.textContent?.includes('release-check-e2e'))?.click()`
    )
    await waitFor<boolean>(
      `document.querySelector('pre')?.innerText.includes('Persisted command content.')`,
      Boolean,
      'the persisted command content after restart'
    )
    if (process.env.OLA_RESOURCES_EVIDENCE_SCREENSHOT) {
      await saveScreenshot(process.env.OLA_RESOURCES_EVIDENCE_SCREENSHOT)
    }
  }, 90_000)

  it('shows a list failure and recovers when Retry reloads the catalogs', async () => {
    await prepareRoot()
    process.env.OLA_E2E_COMMANDS_MANAGE_LIST_FAIL_ONCE = '1'
    await startApp()
    await openResources()
    await waitFor<boolean>(
      `Boolean([...document.querySelectorAll('[role="alert"]')].find((node) => node.textContent?.includes('资源加载失败')))`,
      Boolean,
      'the resource list failure message'
    )
    expect(await evaluate<boolean>(`document.body.innerText.includes('没有可用资源')`)).toBe(false)
    if (process.env.OLA_RESOURCES_FAILURE_SCREENSHOT) {
      await saveScreenshot(process.env.OLA_RESOURCES_FAILURE_SCREENSHOT)
    }
    await clickText('[role="alert"] button', '重试')
    await waitFor<boolean>(
      `!document.body.innerText.includes('资源加载失败') && document.body.innerText.includes('子智能体')`,
      Boolean,
      'the reloaded resource catalog'
    )
    await waitFor<boolean>(
      `Boolean([...document.querySelectorAll('button')].find((button) => button.querySelector('span')?.textContent?.trim() === '子智能体')?.textContent?.match(/[1-9]\\d* 项/)) && !document.body.innerText.includes('加载列表中...')`,
      Boolean,
      'the populated resource catalog after Retry'
    )
  }, 90_000)

  it('shows a detail failure and recovers when Retry reads the selected command', async () => {
    await prepareRoot()
    process.env.OLA_E2E_COMMANDS_MANAGE_READ_FAIL_ONCE = '1'
    await startApp()
    await openResources()
    await evaluate(
      `[...document.querySelectorAll('button')].find((button) => button.querySelector('span')?.textContent?.trim() === '命令')?.click()`
    )
    await waitFor<boolean>(
      `Boolean([...document.querySelectorAll('[role="alert"]')].find((node) => node.textContent?.includes('资源内容加载失败')))`,
      Boolean,
      'the resource detail failure message'
    )
    expect(await evaluate<boolean>(`document.body.innerText.includes('选择一个资源')`)).toBe(false)
    if (process.env.OLA_RESOURCES_DETAIL_FAILURE_SCREENSHOT) {
      await saveScreenshot(process.env.OLA_RESOURCES_DETAIL_FAILURE_SCREENSHOT)
    }
    await clickText('[role="alert"] button', '重试')
    await waitFor<boolean>(
      `Boolean(document.querySelector('pre')?.innerText.trim()) && !document.body.innerText.includes('资源内容加载失败')`,
      Boolean,
      'the selected command content after Retry'
    )
  }, 90_000)
})
