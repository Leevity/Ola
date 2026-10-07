import { once } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'

const require = createRequire(import.meta.url)
const electronBinary = require('electron') as string
const WebSocket = require('ws') as { new (url: string): DevToolsSocket }
const enabled = process.env.RUN_TOP_LEVEL_PAGES_ELECTRON_E2E === '1'
const screenshots = resolve(
  'analysis/audits/2026-10-03-settings-visual/top-level-pages',
  process.env.OLA_PACKAGED_EXE ? 'installed' : 'source'
)

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
let modelServer: Server | undefined

async function command<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!socket) throw new Error('Electron DevTools connection is not open')
  const target = socket
  const id = Math.floor(Math.random() * 1_000_000_000)
  return new Promise((resolveCommand, reject) => {
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
      else resolveCommand(message.result as T)
    }
    target.on('message', onMessage)
    target.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate<T>(expression: string): Promise<T> {
  const response = await command<{ result?: { value?: T } }>('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  return response.result?.value as T
}

async function waitFor(expression: string, description: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await evaluate<boolean>(expression)) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  const state = await evaluate<string>('document.body?.innerText.slice(-1200)')
  const workspace = await evaluate<string>("localStorage.getItem('ola.workspace-context.v1') || ''")
  throw new Error(
    `Timed out waiting for ${description}; workspace=${workspace}; page=${state}; logs=${logs.slice(-2000)}`
  )
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
          await command('Runtime.enable')
          return
        }
      }
    } catch {
      // Main and Renderer may still be starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`Timed out waiting for Electron primary page; logs=${logs.slice(-2000)}`)
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
}

async function screenshot(path: string): Promise<void> {
  const response = await command<{ data?: string }>('Page.captureScreenshot', { format: 'png' })
  if (!response.data) throw new Error(`Screenshot data missing: ${path}`)
  await writeFile(path, Buffer.from(response.data, 'base64'))
}

async function clickText(selector: string, label: string): Promise<boolean> {
  const point = await evaluate<{ x: number; y: number } | null>(
    `(() => { const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => item.textContent?.trim() === ${JSON.stringify(label)}); if (!node) return null; node.scrollIntoView({ block: 'center' }); const rect = node.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } })()`
  )
  if (!point) return false
  await command('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y
  })
  await command('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
  await command('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
  return true
}

async function requestCompressionPreviewAt(messageText: string): Promise<void> {
  await evaluate(`document.querySelector('button[aria-label="关闭环境信息"]')?.click()`)
  await waitFor(
    `document.querySelector('[role="region"][aria-label="环境信息"]') === null`,
    'the environment overlay to close'
  )
  const point = await evaluate<{ x: number; y: number } | null>(`(() => {
    const row = [...document.querySelectorAll('div[class*="group/user"]')].find((item) => item.textContent?.includes(${JSON.stringify(messageText)}))
    const trigger = row?.querySelector('button[aria-label="显示更多"]')
    if (!trigger) return null
    const initialRect = trigger.getBoundingClientRect()
    if (initialRect.top < 80 || initialRect.bottom > innerHeight - 80) {
      trigger.scrollIntoView({ block: 'center' })
    }
    const rect = trigger.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  expect(point).not.toBeNull()
  await command('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point!.x,
    y: point!.y
  })
  await command('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point!.x,
    y: point!.y,
    button: 'left',
    clickCount: 1
  })
  await command('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point!.x,
    y: point!.y,
    button: 'left',
    clickCount: 1
  })
  await waitFor(
    `[...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent?.trim() === '压缩到此处')`,
    'the compression preview menu item'
  )
  expect(await clickText('[role="menuitem"]', '压缩到此处')).toBe(true)
}

async function stopApp(): Promise<void> {
  if (child && child.exitCode === null) {
    const exited = Promise.race([
      once(child, 'exit'),
      new Promise((resolveWait) => setTimeout(resolveWait, 3_000))
    ])
    socket?.send(JSON.stringify({ id: Date.now(), method: 'Browser.close' }))
    await exited
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolveWait) => setTimeout(resolveWait, 3_000))
      ])
    }
  }
  socket?.close()
  socket = undefined
  child = undefined
}

afterEach(async () => {
  await stopApp()
  if (modelServer) {
    await new Promise<void>((resolveClose) => modelServer!.close(() => resolveClose()))
    modelServer = undefined
  }
  logs = ''
  if (root) {
    const target = resolve(root)
    if (!target.startsWith(resolve(tmpdir()) + sep))
      throw new Error('Refusing to remove a non-temporary E2E root')
    await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
  root = undefined
})

describe.skipIf(!enabled)('top-level pages in Electron', () => {
  it('opens the primary pages from the workspace sidebar without layout overflow', async () => {
    root = await mkdtemp(join(tmpdir(), 'ola-top-level-pages-electron-'))
    let compressionRequests = 0
    const modelPaths: string[] = []
    modelServer = createServer((request, response) => {
      const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      modelPaths.push(requestPath)
      if (requestPath !== '/v1/chat/completions') {
        response.writeHead(404).end()
        return
      }
      compressionRequests += 1
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          'data: {"choices":[{"delta":{"content":"E2E compact summary preserves the user request."}}]}\n\ndata: [DONE]\n\n'
        )
      })
    })
    await new Promise<void>((resolveListen) => modelServer!.listen(0, '127.0.0.1', resolveListen))
    const modelAddress = modelServer.address()
    if (!modelAddress || typeof modelAddress === 'string') throw new Error('Model fixture address')
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
    await writeFile(
      join(root, 'config.json'),
      JSON.stringify({
        'ola-providers': {
          state: {
            providers: [
              {
                id: 'e2e-provider',
                name: 'E2E Provider',
                type: 'openai-chat',
                apiKey: '',
                baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
                enabled: true,
                requiresApiKey: false,
                createdAt: Date.now(),
                models: [
                  { id: 'e2e-main', name: 'E2E Main', enabled: true, category: 'chat' },
                  { id: 'e2e-secondary', name: 'E2E Secondary', enabled: true, category: 'chat' },
                  { id: 'e2e-disabled', name: 'E2E Disabled', enabled: false, category: 'chat' },
                  { id: 'e2e-image', name: 'E2E Image', enabled: true, category: 'image' }
                ]
              }
            ],
            activeProviderId: 'e2e-provider',
            activeModelId: 'e2e-main'
          },
          version: 0
        }
      }),
      'utf8'
    )
    const repository = new BusinessRepository({ path: join(root, 'data.db'), mode: 'direct' })
    await repository.createSession({
      id: 'palette-model-session-e2e',
      title: 'Palette model session E2E',
      mode: 'chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspaceId: 'local-personal'
    })
    await repository.createSession({
      id: 'compression-session-e2e',
      title: 'Compression session E2E',
      mode: 'chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspaceId: 'local-personal'
    })
    await repository.addMessages({
      workspaceId: 'local-personal',
      messages: [
        ['user', 'Please analyze the project.'],
        ['assistant', 'I inspected the project.'],
        ['user', 'Remember the original requirement.'],
        ['assistant', 'I will preserve it.']
      ].map(([role, content], index) => ({
        id: `compression-original-${index}`,
        sessionId: 'compression-session-e2e',
        role,
        content: JSON.stringify(content),
        createdAt: Date.now() + index,
        sortOrder: index
      }))
    })
    await repository.createSession({
      id: 'preview-session-e2e',
      title: 'Preview session E2E',
      mode: 'chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspaceId: 'local-personal'
    })
    await repository.addMessages({
      workspaceId: 'local-personal',
      messages: [
        ['user', 'Preview the first requirement.'],
        ['assistant', 'The first requirement is preserved.'],
        ['user', 'Keep the second requirement too.'],
        ['assistant', 'Both requirements are now in scope.']
      ].map(([role, content], index) => ({
        id: `preview-original-${index}`,
        sessionId: 'preview-session-e2e',
        role,
        content: JSON.stringify(content),
        createdAt: Date.now() + index,
        sortOrder: index
      }))
    })
    await repository.close()
    await mkdir(screenshots, { recursive: true })
    await startApp()
    await waitFor(
      `Boolean([...document.querySelectorAll('button')].find((button) => button.innerText.includes('扩展功能')))`,
      'the workspace sidebar'
    )
    await waitFor(`document.body.innerText.includes('新建项目')`, 'the localized default project')
    expect(await evaluate<string>('document.body.innerText')).not.toContain('New Project')

    const pages = [
      { label: '任务与自动化', title: '任务', file: '01-tasks.png', direct: true },
      { label: '资源', file: '02-resources.png' },
      { label: '绘图', file: '03-draw.png' },
      { label: '技能', file: '04-skills.png' },
      { label: 'SOUL', file: '05-souls.png' },
      { label: '同步', file: '06-sync.png' }
    ]

    for (const page of pages) {
      if (page.direct) {
        const clicked = await clickText('button', page.label)
        expect(clicked, `sidebar button: ${page.label}`).toBe(true)
      } else {
        if (
          !(await evaluate<boolean>(
            `[...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '扩展功能')`
          ))
        ) {
          await waitFor(
            `Boolean(document.querySelector('button[aria-label="切换侧边栏"]'))`,
            'the workspace sidebar toggle'
          )
          await evaluate(`document.querySelector('button[aria-label="切换侧边栏"]')?.click()`)
          await waitFor(
            `[...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '扩展功能')`,
            'the restored workspace sidebar'
          )
        }
        expect(await clickText('button', '扩展功能')).toBe(true)
        await waitFor(
          `Boolean([...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.trim() === ${JSON.stringify(page.label)}))`,
          `${page.label} menu item`
        )
        const clicked = await clickText('[role="menuitem"]', page.label)
        expect(clicked, `extension menu item: ${page.label}`).toBe(true)
      }
      await waitFor(
        `document.querySelector('.workspace-titlebar-surface')?.innerText.includes(${JSON.stringify(page.title ?? page.label)}) === true`,
        `${page.label} title`
      )
      if (page.label === '任务与自动化') {
        await waitFor(
          `document.body.innerText.includes('任务日历') && [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '任务看板')`,
          'the localized task calendar'
        )
        const calendarControls = await evaluate<{
          board: boolean
          previousMonth: boolean
          nextMonth: boolean
          namedDays: number
          statusFilter: boolean
          sessionFilter: boolean
          directoryFilter: boolean
        }>(`(() => ({
          board: [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '任务看板'),
          previousMonth: Boolean(document.querySelector('button[aria-label="上个月"]')),
          nextMonth: Boolean(document.querySelector('button[aria-label="下个月"]')),
          namedDays: [...document.querySelectorAll('button[aria-pressed]')].filter((button) => button.getAttribute('aria-label')?.includes('项任务')).length,
          statusFilter: Boolean(document.querySelector('select[aria-label="按任务状态筛选"]')),
          sessionFilter: Boolean(document.querySelector('select[aria-label="按会话筛选任务"]')),
          directoryFilter: Boolean(document.querySelector('input[aria-label="按工作目录筛选任务"]'))
        }))()`)
        expect(
          calendarControls?.namedDays,
          JSON.stringify(calendarControls)
        ).toBeGreaterThanOrEqual(35)
        expect(calendarControls?.namedDays % 7).toBe(0)
        expect(calendarControls).toMatchObject({
          board: true,
          previousMonth: true,
          nextMonth: true,
          statusFilter: true,
          sessionFilter: true,
          directoryFilter: true
        })
        const currentMonth = await evaluate<string>(
          `document.querySelector('button[aria-label="上个月"]')?.nextElementSibling?.textContent?.trim() ?? ''`
        )
        await evaluate(`document.querySelector('button[aria-label="上个月"]')?.click()`)
        await waitFor(
          `document.querySelector('button[aria-label="上个月"]')?.nextElementSibling?.textContent?.trim() !== ${JSON.stringify(currentMonth)}`,
          'the previous task calendar month'
        )
        await evaluate(`document.querySelector('button[aria-label="下个月"]')?.click()`)
        await waitFor(
          `document.querySelector('button[aria-label="上个月"]')?.nextElementSibling?.textContent?.trim() === ${JSON.stringify(currentMonth)}`,
          'the restored task calendar month'
        )
        const keyboardDate = await evaluate<{ original: string; target: string }>(`(() => {
          const days = [...document.querySelectorAll('button[aria-pressed]')]
          const activeIndex = days.findIndex((day) => day.getAttribute('aria-pressed') === 'true')
          const original = days[activeIndex]
          const target = days[(activeIndex + 1) % days.length]
          target?.focus()
          return {
            original: original?.getAttribute('aria-label') ?? '',
            target: document.activeElement === target ? target?.getAttribute('aria-label') ?? '' : ''
          }
        })()`)
        expect(keyboardDate?.target).not.toBe('')
        await evaluate(
          `document.querySelector('button[aria-label=${JSON.stringify(keyboardDate?.target)}]')?.click()`
        )
        await waitFor(
          `document.querySelector('button[aria-label=${JSON.stringify(keyboardDate?.target)}]')?.getAttribute('aria-pressed') === 'true'`,
          'the selected task calendar day'
        )
        await evaluate(
          `document.querySelector('button[aria-label=${JSON.stringify(keyboardDate?.original)}]')?.click()`
        )
      }
      if (page.label === '技能') {
        await waitFor(`document.body.innerText.includes('SKILLS')`, 'the skills page')
        await waitFor(
          `!document.body.innerText.includes('Loading...') && !document.body.innerText.includes('正在加载...')`,
          'the skills catalog'
        )
        const marketState = await evaluate<string>('document.body.innerText')
        if (marketState.includes('技能市场暂不可用')) {
          expect(marketState).not.toContain('无匹配的技能')
          expect(marketState).toContain('重试')
        }
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 400))
      const issues = await evaluate<string[]>(`(() => {
        const issues = [];
        if (document.documentElement.scrollWidth > innerWidth + 2) issues.push('document horizontal overflow');
        if ([...document.querySelectorAll('[role="alert"]')].some((node) => /失败|错误|Error|Failed/.test(node.textContent || ''))) issues.push('visible error alert');
        return issues;
      })()`)
      expect(issues, `${page.label} first-screen layout`).toEqual([])
      await screenshot(join(screenshots, page.file))
      if (page.label === '任务与自动化') {
        await command('Emulation.setDeviceMetricsOverride', {
          width: Math.round(760 / 1.5),
          height: Math.round(560 / 1.5),
          deviceScaleFactor: 1.5,
          mobile: false
        })
        await new Promise((resolveWait) => setTimeout(resolveWait, 350))
        const narrowLayout = await evaluate<{
          viewport: { width: number; height: number }
          documentWidth: number
          left: { width: number; bottom: number } | null
          right: { width: number; y: number } | null
          calendar: { bottom: number } | null
          scroll: { height: number; viewport: number }
        }>(`(() => {
          const calendar = document.querySelector('button[aria-label="上个月"]')?.closest('section')
          const left = calendar?.parentElement
          const right = left?.nextElementSibling
          const root = left?.parentElement
          const rect = (element) => {
            const bounds = element?.getBoundingClientRect()
            return bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, right: bounds.right, bottom: bounds.bottom } : null
          }
          return {
            viewport: { width: innerWidth, height: innerHeight },
            documentWidth: document.documentElement.scrollWidth,
            left: rect(left),
            right: rect(right),
            calendar: rect(calendar),
            scroll: { height: root?.scrollHeight ?? 0, viewport: root?.clientHeight ?? 0 }
          }
        })()`)
        await writeFile(
          join(screenshots, '01-tasks-narrow-layout.json'),
          JSON.stringify(narrowLayout, null, 2),
          'utf8'
        )
        await screenshot(join(screenshots, '01-tasks-narrow.png'))
        expect(narrowLayout?.documentWidth).toBeLessThanOrEqual(narrowLayout?.viewport.width ?? 0)
        expect(narrowLayout?.left?.width).toBeGreaterThanOrEqual(280)
        expect(narrowLayout?.right?.width).toBeGreaterThanOrEqual(280)
        expect(narrowLayout?.right?.y).toBeGreaterThanOrEqual(narrowLayout?.left?.bottom ?? 0)
        expect(narrowLayout?.calendar?.bottom).toBeLessThanOrEqual(narrowLayout?.left?.bottom ?? 0)
        expect(narrowLayout?.scroll.height).toBeGreaterThan(narrowLayout?.scroll.viewport ?? 0)
        await evaluate(`(() => {
          const calendar = document.querySelector('button[aria-label="上个月"]')?.closest('section')
          const root = calendar?.parentElement?.parentElement
          root.scrollTop = root.scrollHeight
        })()`)
        const scrolledDetailExpression = `(() => {
          const calendar = document.querySelector('button[aria-label="上个月"]')?.closest('section')
          const bounds = calendar?.parentElement?.nextElementSibling?.getBoundingClientRect()
          return { top: bounds?.top ?? Infinity, width: bounds?.width ?? 0 }
        })()`
        await waitFor(
          `${scrolledDetailExpression}.top < ${narrowLayout?.viewport.height ?? 0}`,
          'the scrolled narrow task details'
        )
        const scrolledDetail = await evaluate<{ top: number; width: number }>(
          scrolledDetailExpression
        )
        expect(scrolledDetail?.top).toBeLessThan(narrowLayout?.viewport.height ?? 0)
        expect(scrolledDetail?.width).toBeGreaterThanOrEqual(280)
        await screenshot(join(screenshots, '01-tasks-narrow-detail.png'))
        await stopApp()
        await startApp()
      }
    }

    await stopApp()
    await startApp()
    await waitFor(
      `document.body.innerText.includes('新建项目')`,
      'the saved default project after restart'
    )
    expect(await evaluate<string>('document.body.innerText')).not.toContain('New Project')
    expect(await clickText('button', '搜索')).toBe(true)
    await waitFor(`Boolean(document.querySelector('[role="dialog"]'))`, 'the command palette')
    const searchDialog = await evaluate<{ title: string; description: string }>(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const title = document.getElementById(dialog?.getAttribute('aria-labelledby') || '');
      const description = document.getElementById(dialog?.getAttribute('aria-describedby') || '');
      return { title: title?.textContent?.trim() || '', description: description?.textContent?.trim() || '' };
    })()`)
    expect(searchDialog).toEqual({ title: '命令面板', description: '搜索命令、操作和会话' })
    await new Promise((resolveWait) => setTimeout(resolveWait, 350))
    await screenshot(join(screenshots, '07-search.png'))
    await command('Input.insertText', { text: '解释这段代码' })
    await waitFor(
      `Boolean([...document.querySelectorAll('[cmdk-item]')].find((item) => item.textContent?.trim() === '解释这段代码' && item.getBoundingClientRect().bottom < innerHeight))`,
      'the filtered quick prompt'
    )
    expect(await clickText('[cmdk-item]', '解释这段代码')).toBe(true)
    await waitFor(
      `document.querySelector('.composer-editor-content')?.textContent?.startsWith('详细解释以下代码的作用和实现方式：') === true`,
      'the localized quick prompt in the composer'
    )
    await waitFor(
      `document.querySelector('[role="dialog"]') === null`,
      'the command palette to close'
    )
    expect(await clickText('button', '搜索')).toBe(true)
    await waitFor(`Boolean(document.querySelector('[role="dialog"]'))`, 'the model command palette')
    const modelChoices = await evaluate<string[]>(
      `[...document.querySelectorAll('[cmdk-item]')].map((item) => item.textContent?.trim() ?? '')`
    )
    expect(modelChoices.some((choice) => choice.includes('E2E Secondary'))).toBe(true)
    expect(modelChoices.some((choice) => choice.includes('E2E Disabled'))).toBe(false)
    expect(modelChoices.some((choice) => choice.includes('E2E Image'))).toBe(false)
    await command('Input.insertText', { text: 'E2E Secondary' })
    await waitFor(
      `Boolean([...document.querySelectorAll('[cmdk-item]')].find((item) => item.textContent?.includes('E2E Secondary') && item.getBoundingClientRect().bottom < innerHeight))`,
      'the configured model option'
    )
    const modelSelected = await evaluate<boolean>(`(() => {
      const item = [...document.querySelectorAll('[cmdk-item]')].find((node) => node.textContent?.includes('E2E Secondary'))
      item?.click()
      return Boolean(item)
    })()`)
    expect(modelSelected).toBe(true)
    await waitFor(
      `JSON.parse(localStorage.getItem('ola.workspace-context.v1') || '{}').state?.modelSelections?.['local-personal']?.modelId === 'e2e-secondary'`,
      'the active workspace model to switch'
    )
    await waitFor(
      `document.querySelector('[role="dialog"]') === null`,
      'the model palette to close'
    )
    await evaluate('location.reload()')
    await waitFor(
      `JSON.parse(localStorage.getItem('ola.workspace-context.v1') || '{}').state?.modelSelections?.['local-personal']?.modelId === 'e2e-secondary'`,
      'the selected workspace model after renderer reload'
    )
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
    await stopApp()
    const savedSettings = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')) as {
      'ola-settings': { state: { mainModelSelectionMode?: string } }
    }
    expect(savedSettings['ola-settings'].state.mainModelSelectionMode).toBe('manual')
    await startApp()
    await waitFor(
      `JSON.parse(localStorage.getItem('ola.workspace-context.v1') || '{}').state?.modelSelections?.['local-personal']?.modelId === 'e2e-secondary'`,
      'the selected workspace model after restart'
    )
    await waitFor(
      `document.body.innerText.includes('Palette model session E2E')`,
      'the model test session in the sidebar'
    )
    const sessionOpened = await evaluate<boolean>(`(() => {
      const label = [...document.querySelectorAll('span')].find((item) => item.textContent?.trim() === 'Palette model session E2E')
      const button = label?.closest('button')
      button?.click()
      return Boolean(button)
    })()`)
    expect(sessionOpened).toBe(true)
    await waitFor(
      `Boolean(document.querySelector('.composer-editor-content')) && document.body.innerText.includes('输入消息')`,
      'the active model test session'
    )
    const contextRing = await evaluate<{
      fontSize: number
      width: number
      focusable: boolean
    }>(`(() => {
      const button = document.querySelector('button[aria-label="点击压缩上下文"]')
      const label = button?.querySelector('span')
      button?.focus()
      return {
        fontSize: label ? Number.parseFloat(getComputedStyle(label).fontSize) : 0,
        width: button?.getBoundingClientRect().width ?? 0,
        focusable: document.activeElement === button
      }
    })()`)
    expect(contextRing.fontSize).toBeGreaterThanOrEqual(10)
    expect(contextRing.width).toBeGreaterThanOrEqual(32)
    expect(contextRing.focusable).toBe(true)
    await evaluate(`document.querySelector('button[aria-label="点击压缩上下文"]')?.click()`)
    await waitFor(
      `document.body.innerText.includes('当前没有可压缩的消息。')`,
      'the localized compression blocker'
    )
    await screenshot(join(screenshots, '07-context-compression.png'))
    const compressionSessionOpened = await evaluate<boolean>(`(() => {
      const label = [...document.querySelectorAll('span')].find((item) => item.textContent?.trim() === 'Compression session E2E')
      const button = label?.closest('button')
      button?.click()
      return Boolean(button)
    })()`)
    expect(compressionSessionOpened).toBe(true)
    await waitFor(
      `document.body.innerText.includes('Remember the original requirement.') && Boolean(document.querySelector('button[aria-label="点击压缩上下文"]'))`,
      'the seeded compression session'
    )
    const businessDb = new DatabaseSync(join(root, 'data.db'))
    businessDb.exec(`CREATE TRIGGER reject_compression_summary BEFORE INSERT ON messages
      WHEN NEW.session_id = 'compression-session-e2e' AND NEW.id LIKE 'oc_%'
      BEGIN SELECT RAISE(ABORT, 'compression write denied'); END`)
    businessDb.close()
    await evaluate(`document.querySelector('button[aria-label="点击压缩上下文"]')?.click()`)
    await waitFor(
      `document.body.innerText.includes('上下文压缩失败')`,
      'compression persistence failure'
    )
    expect(
      compressionRequests,
      `paths=${modelPaths.join(',')} logs=${logs.slice(-2000)}`
    ).toBeGreaterThan(0)
    const failedDb = new DatabaseSync(join(root, 'data.db'))
    expect(
      (
        failedDb
          .prepare(
            "SELECT COUNT(*) AS count FROM messages WHERE session_id = 'compression-session-e2e'"
          )
          .get() as { count: number }
      ).count
    ).toBe(4)
    failedDb.exec('DROP TRIGGER reject_compression_summary')
    failedDb.close()
    await evaluate(`document.querySelector('button[aria-label="点击压缩上下文"]')?.click()`)
    await waitFor(
      `document.body.innerText.includes('上下文已压缩')`,
      'persisted context compression'
    )
    const compressedDb = new DatabaseSync(join(root, 'data.db'))
    expect(
      (
        compressedDb
          .prepare(
            "SELECT COUNT(*) AS count FROM messages WHERE session_id = 'compression-session-e2e' AND id LIKE 'oc_%'"
          )
          .get() as { count: number }
      ).count
    ).toBeGreaterThanOrEqual(2)
    compressedDb.close()
    await waitFor(`!document.body.innerText.includes('压缩失败')`, 'the cleared compression error')
    await screenshot(join(screenshots, '08-context-compression-persisted.png'))
    const previewSessionOpened = await evaluate<boolean>(`(() => {
      const label = [...document.querySelectorAll('span')].find((item) => item.textContent?.trim() === 'Preview session E2E')
      const button = label?.closest('button')
      button?.click()
      return Boolean(button)
    })()`)
    expect(previewSessionOpened).toBe(true)
    await waitFor(
      `document.body.innerText.includes('Preview the first requirement.')`,
      'the preview session'
    )
    await requestCompressionPreviewAt('Keep the second requirement too.')
    await waitFor(
      `Boolean(document.querySelector('[role="dialog"]')?.textContent?.includes('E2E compact summary preserves the user request.'))`,
      'the context summary preview'
    )
    const previewDb = new DatabaseSync(join(root, 'data.db'))
    expect(
      (
        previewDb
          .prepare(
            "SELECT COUNT(*) AS count FROM messages WHERE session_id = 'preview-session-e2e'"
          )
          .get() as { count: number }
      ).count
    ).toBe(4)
    previewDb.close()
    const previewCancelled = await evaluate<boolean>(`(() => {
      const button = [...(document.querySelector('[role="dialog"]')?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.trim() === '取消')
      button?.click()
      return Boolean(button)
    })()`)
    expect(previewCancelled).toBe(true)
    await waitFor(`document.querySelector('[role="dialog"]') === null`, 'the cancelled preview')
    await requestCompressionPreviewAt('Keep the second requirement too.')
    await waitFor(
      `Boolean(document.querySelector('[role="dialog"]')?.textContent?.includes('E2E compact summary preserves the user request.'))`,
      'the renewed context summary preview'
    )
    await evaluate(`(() => {
      const label = [...document.querySelectorAll('span')].find((item) => item.textContent?.trim() === 'Compression session E2E')
      label?.closest('button')?.click()
    })()`)
    await waitFor(
      `location.hash.includes('compression-session-e2e') && document.querySelector('[role="dialog"]') === null`,
      'the discarded preview after switching sessions'
    )
    const switchedPreviewDb = new DatabaseSync(join(root, 'data.db'))
    expect(
      (
        switchedPreviewDb
          .prepare(
            "SELECT COUNT(*) AS count FROM messages WHERE session_id = 'preview-session-e2e'"
          )
          .get() as { count: number }
      ).count
    ).toBe(4)
    switchedPreviewDb.close()
    await evaluate(`(() => {
      const label = [...document.querySelectorAll('span')].find((item) => item.textContent?.trim() === 'Preview session E2E')
      label?.closest('button')?.click()
    })()`)
    await waitFor(`location.hash.includes('preview-session-e2e')`, 'the restored preview session')
    await requestCompressionPreviewAt('Keep the second requirement too.')
    await waitFor(
      `Boolean(document.querySelector('[role="dialog"]')?.textContent?.includes('E2E compact summary preserves the user request.'))`,
      'the final context summary preview'
    )
    const previewConfirmed = await evaluate<boolean>(`(() => {
      const button = [...(document.querySelector('[role="dialog"]')?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.trim() === '确认整理')
      button?.click()
      return Boolean(button)
    })()`)
    expect(previewConfirmed).toBe(true)
    await waitFor(
      `document.querySelector('[role="dialog"]') === null`,
      'the applied context summary'
    )
    const appliedPreviewDb = new DatabaseSync(join(root, 'data.db'))
    expect(
      (
        appliedPreviewDb
          .prepare(
            "SELECT COUNT(*) AS count FROM messages WHERE session_id = 'preview-session-e2e' AND id LIKE 'oc_%'"
          )
          .get() as { count: number }
      ).count
    ).toBeGreaterThanOrEqual(2)
    expect(
      (
        appliedPreviewDb
          .prepare(
            "SELECT COUNT(*) AS count FROM messages WHERE session_id = 'preview-session-e2e' AND id LIKE 'preview-original-%'"
          )
          .get() as { count: number }
      ).count
    ).toBe(4)
    appliedPreviewDb.close()
    await screenshot(join(screenshots, '09-context-compression-preview-applied.png'))
    await evaluate(`(() => {
      const label = [...document.querySelectorAll('span')].find((item) => item.textContent?.trim() === 'Palette model session E2E')
      label?.closest('button')?.click()
    })()`)
    await waitFor(
      `location.hash.includes('palette-model-session-e2e') && document.querySelector('.composer-editor-content') !== null`,
      'the model selection session after compression acceptance'
    )
    const sidebarTextSizes = await evaluate<{ headings: number[]; sessionTime: number }>(`(() => {
      const headings = [...document.querySelectorAll('span')]
        .filter((node) => ['项目', '对话'].includes(node.textContent?.trim() || ''))
        .map((node) => Number.parseFloat(getComputedStyle(node).fontSize))
      const row = [...document.querySelectorAll('button')].find((node) => node.textContent?.includes('Palette model session E2E'))
      const time = row && [...row.querySelectorAll('span')].find((node) => /刚刚|分钟前|小时前|天前/.test(node.textContent || ''))
      return { headings, sessionTime: time ? Number.parseFloat(getComputedStyle(time).fontSize) : 0 }
    })()`)
    expect(sidebarTextSizes.headings.length).toBeGreaterThanOrEqual(2)
    expect(Math.min(...sidebarTextSizes.headings)).toBeGreaterThanOrEqual(11)
    expect(sidebarTextSizes.sessionTime).toBeGreaterThanOrEqual(11)
    expect(await clickText('button', '搜索')).toBe(true)
    await waitFor(`Boolean(document.querySelector('[role="dialog"]'))`, 'the session model palette')
    await command('Input.insertText', { text: 'E2E Main' })
    await waitFor(
      `Boolean([...document.querySelectorAll('[cmdk-item]')].find((item) => item.textContent?.includes('E2E Main') && item.getBoundingClientRect().bottom < innerHeight))`,
      'the active session model option'
    )
    const sessionModelSelected = await evaluate<boolean>(`(() => {
      const item = [...document.querySelectorAll('[cmdk-item]')].find((node) => node.textContent?.includes('E2E Main'))
      item?.click()
      return Boolean(item)
    })()`)
    expect(sessionModelSelected).toBe(true)
    await waitFor(
      `document.querySelector('[role="dialog"]') === null`,
      'the session palette to close'
    )
    expect(
      await evaluate<string>(
        `JSON.parse(localStorage.getItem('ola.workspace-context.v1') || '{}').state?.modelSelections?.['local-personal']?.modelId`
      )
    ).toBe('e2e-secondary')
    await stopApp()
    const persistedRepository = new BusinessRepository({
      path: join(root, 'data.db'),
      mode: 'direct'
    })
    const persistedSession = await persistedRepository.session<{
      provider_id: string
      model_id: string
      model_selection_mode: string
    }>('palette-model-session-e2e', 'local-personal')
    await persistedRepository.close()
    expect(persistedSession).toMatchObject({
      provider_id: 'e2e-provider',
      model_id: 'e2e-main',
      model_selection_mode: 'manual'
    })
    await startApp()
    await waitFor(
      `document.body.innerText.includes('新建项目')`,
      'the workspace after session restart'
    )
    const restoredCompressionSession = await evaluate<boolean>(`(() => {
      const label = [...document.querySelectorAll('span')].find((item) => item.textContent?.trim() === 'Compression session E2E')
      const button = label?.closest('button')
      button?.click()
      return Boolean(button)
    })()`)
    expect(restoredCompressionSession).toBe(true)
    await waitFor(
      `document.body.innerText.includes('E2E compact summary preserves the user request.')`,
      'the persisted compression summary after restart'
    )

    const registry = await readFile(
      resolve('src/renderer/src/components/settings/settings-registry.ts'),
      'utf8'
    )
    const registryEntries = registry.slice(
      registry.indexOf('export const SETTINGS_REGISTRY'),
      registry.indexOf('const pageById')
    )
    const settingsRoutes = [
      ...registryEntries.matchAll(
        /\{\s*id:\s*'([^']+)'[\s\S]*?section:\s*'([^']+)'[\s\S]*?\n\s*\}/g
      )
    ].map((match) => `#/settings/${match[2]}/${match[1]}`)
    expect(settingsRoutes).toHaveLength(22)
    for (const route of settingsRoutes) {
      await evaluate(`window.location.hash = ${JSON.stringify(route)}`)
      await waitFor(`location.hash === ${JSON.stringify(route)}`, `${route} navigation`)
      await new Promise((resolveWait) => setTimeout(resolveWait, 300))
      const issues = await evaluate<string[]>(`(() => {
        const issues = [];
        if (!document.querySelector('.settings-page')) issues.push('settings page did not render');
        if (!document.querySelector('#root') || document.body.innerText.length < 80) issues.push('empty page');
        if (/minified react error|出了点问题/i.test(document.body.innerText)) issues.push('error boundary');
        if (document.documentElement.scrollWidth > innerWidth + 2) issues.push('document horizontal overflow');
        return issues;
      })()`)
      expect(issues, `${route} route smoke`).toEqual([])
      if (route === '#/settings/execution/desktopAutomation') {
        await command('Emulation.setDeviceMetricsOverride', {
          width: 760,
          height: 560,
          deviceScaleFactor: 1,
          mobile: false
        })
        await new Promise((resolveWait) => setTimeout(resolveWait, 300))
        const recordingLayout = await evaluate<{
          viewport: { width: number; height: number }
          documentWidth: number
          startButton: { top: number; bottom: number; width: number } | null
          inputLabel: string | null
          safetyNoticeVisible: boolean
        }>(`(() => {
          const start = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === '开始录制')
          const bounds = start?.getBoundingClientRect()
          const input = document.querySelector('#desktop-flow-name')
          const notice = [...document.querySelectorAll('p')].find((node) => node.textContent?.includes('不会保存键入文本'))
          return {
            viewport: { width: innerWidth, height: innerHeight },
            documentWidth: document.documentElement.scrollWidth,
            startButton: bounds ? { top: bounds.top, bottom: bounds.bottom, width: bounds.width } : null,
            inputLabel: input?.labels?.[0]?.textContent?.trim() ?? null,
            safetyNoticeVisible: Boolean(notice && notice.getBoundingClientRect().bottom <= innerHeight)
          }
        })()`)
        await writeFile(
          join(screenshots, '10-desktop-automation-compact-layout.json'),
          JSON.stringify(recordingLayout, null, 2),
          'utf8'
        )
        await screenshot(join(screenshots, '10-desktop-automation-compact.png'))
        expect(recordingLayout.documentWidth).toBeLessThanOrEqual(recordingLayout.viewport.width)
        expect(recordingLayout.startButton?.width).toBeGreaterThanOrEqual(80)
        expect(recordingLayout.startButton?.bottom).toBeLessThanOrEqual(
          recordingLayout.viewport.height
        )
        expect(recordingLayout.inputLabel).toBe('流程名称')
        expect(recordingLayout.safetyNoticeVisible).toBe(true)

        if (!root) throw new Error('Missing isolated E2E root')
        const unavailableDb = new DatabaseSync(join(root, 'data.db'))
        try {
          unavailableDb.exec(
            'ALTER TABLE desktop_flows RENAME TO desktop_flows_e2e_temporarily_unavailable'
          )
        } finally {
          unavailableDb.close()
        }
        try {
          await evaluate(`window.location.hash = '#/settings/execution/system'`)
          await waitFor(
            `location.hash === '#/settings/execution/system'`,
            'system settings during desktop flow failure'
          )
          await evaluate(`window.location.hash = '#/settings/execution/desktopAutomation'`)
          await waitFor(
            `Boolean([...document.querySelectorAll('[role="alert"]')].find((item) => item.textContent?.includes('读取桌面流程失败，请重试。')))`,
            'visible desktop flow load failure'
          )
          await evaluate(
            `document.querySelector('[role="alert"]')?.scrollIntoView({ block: 'center' })`
          )
          await screenshot(join(screenshots, '10-desktop-automation-load-failure.png'))
        } finally {
          const restoredDb = new DatabaseSync(join(root, 'data.db'))
          try {
            restoredDb.exec(
              'ALTER TABLE desktop_flows_e2e_temporarily_unavailable RENAME TO desktop_flows'
            )
          } finally {
            restoredDb.close()
          }
        }
        const retried = await evaluate<boolean>(`(() => {
          const alert = [...document.querySelectorAll('[role="alert"]')].find((item) => item.textContent?.includes('读取桌面流程失败，请重试。'))
          const button = [...(alert?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.includes('重试读取'))
          button?.click()
          return Boolean(button)
        })()`)
        expect(retried).toBe(true)
        await waitFor(
          `document.body.innerText.includes('空闲 · 0 个步骤') && ![...document.querySelectorAll('[role="alert"]')].some((item) => item.textContent?.includes('读取桌面流程失败'))`,
          'desktop flow recovery after retry'
        )
        const started = await evaluate<boolean>(`(() => {
          const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === '开始录制')
          button?.click()
          return Boolean(button)
        })()`)
        expect(started).toBe(true)
        await waitFor(`document.body.innerText.includes('正在录制')`, 'desktop recording to start')
        const rejectSaveDb = new DatabaseSync(join(root, 'data.db'))
        try {
          rejectSaveDb.exec(`CREATE TRIGGER desktop_flows_e2e_reject
            BEFORE INSERT ON desktop_flows
            BEGIN SELECT RAISE(ABORT, 'E2E_DESKTOP_FLOW_SAVE_REJECTED'); END`)
        } finally {
          rejectSaveDb.close()
        }
        try {
          const stopped = await evaluate<boolean>(`(() => {
            const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === '停止并保存')
            button?.click()
            return Boolean(button)
          })()`)
          expect(stopped).toBe(true)
          await waitFor(
            `document.body.innerText.includes('停止或保存录制失败') && document.body.innerText.includes('正在录制')`,
            'recording retained after save failure'
          )
          await screenshot(join(screenshots, '10-desktop-automation-save-failure.png'))
        } finally {
          const restoreSaveDb = new DatabaseSync(join(root, 'data.db'))
          try {
            restoreSaveDb.exec('DROP TRIGGER desktop_flows_e2e_reject')
          } finally {
            restoreSaveDb.close()
          }
        }
        const retriedStop = await evaluate<boolean>(`(() => {
          const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === '停止并保存')
          button?.click()
          return Boolean(button)
        })()`)
        expect(retriedStop).toBe(true)
        await waitFor(
          `document.body.innerText.includes('空闲 · 0 个步骤') && document.body.innerText.includes('桌面流程 · 0 个步骤')`,
          'desktop flow persisted after retry'
        )
        const savedDb = new DatabaseSync(join(root, 'data.db'), { readOnly: true })
        try {
          const savedCount = savedDb
            .prepare(
              "SELECT COUNT(*) AS count FROM desktop_flows WHERE workspace_id='local-personal'"
            )
            .get() as { count: number }
          expect(savedCount.count).toBe(1)
        } finally {
          savedDb.close()
        }
        await waitFor(
          `!document.body.innerText.includes('停止或保存录制失败')`,
          'the transient desktop flow failure toast to expire'
        )
        await screenshot(join(screenshots, '10-desktop-automation-save-recovered.png'))
        await command('Emulation.clearDeviceMetricsOverride')
      }
    }
  }, 120_000)
})
