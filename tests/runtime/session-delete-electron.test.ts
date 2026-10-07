import { once } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'

const require = createRequire(import.meta.url)
type DevToolsSocket = {
  readyState: number
  close(): void
  on(event: 'message', listener: (raw: Buffer | string) => void): void
  off(event: 'message', listener: (raw: Buffer | string) => void): void
  send(data: string): void
  once(event: 'open', listener: () => void): void
}
const WebSocket = require('ws') as { new (url: string): DevToolsSocket; OPEN: number }
const electronBinary = require('electron') as string
const enabled = process.env.RUN_SESSION_DELETE_ELECTRON_E2E === '1'

let root: string | undefined
let child: ChildProcess | undefined
let sockets: DevToolsSocket[] = []
let logs = ''

async function pageTarget(port: number, predicate: (url: string) => boolean) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      if (response.ok) {
        const targets = (await response.json()) as Array<{
          type: string
          url?: string
          webSocketDebuggerUrl?: string
        }>
        const target = targets.find(
          (entry) =>
            entry.type === 'page' &&
            Boolean(entry.webSocketDebuggerUrl) &&
            predicate(entry.url ?? '')
        )
        if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl
      }
    } catch {
      // The Electron process is still starting or opening the detached window.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for an Electron page. ${logs.slice(-4000)}`)
}

async function waitUntilNoPage(port: number, predicate: (url: string) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/json`)
    if (response.ok) {
      const targets = (await response.json()) as Array<{ type: string; url?: string }>
      if (!targets.some((target) => target.type === 'page' && predicate(target.url ?? ''))) return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for an Electron page to close. ${logs.slice(-4000)}`)
}

async function connect(url: string): Promise<DevToolsSocket> {
  const socket = new WebSocket(url)
  sockets.push(socket)
  await new Promise<void>((resolve) => socket.once('open', resolve))
  return socket
}

async function call(
  socket: DevToolsSocket,
  method: string,
  params: Record<string, unknown> = {}
): Promise<{ result?: { result?: { value?: unknown } } }> {
  const id = Math.floor(Math.random() * 1_000_000_000)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      const detail = typeof params.expression === 'string' ? ` (${params.expression})` : ''
      reject(new Error(`Timed out waiting for DevTools method ${method}${detail}`))
    }, 12_000)
    const onMessage = (raw: Buffer | string): void => {
      const message = JSON.parse(raw.toString()) as {
        id?: number
        error?: { message: string }
        result?: { result?: { value?: unknown } }
      }
      if (message.id !== id) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      if (message.error) reject(new Error(`${method}: ${message.error.message}`))
      else resolve({ result: message.result })
    }
    socket.on('message', onMessage)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function waitFor<T>(
  socket: DevToolsSocket,
  expression: string,
  predicate: (value: T | undefined) => boolean,
  description: string
): Promise<T> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await call(socket, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    const value = response.result?.result?.value as T | undefined
    if (predicate(value)) return value as T
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${description}. ${logs.slice(-4000)}`)
}

afterEach(async () => {
  for (const socket of sockets) socket.close()
  sockets = []
  if (child && !child.killed) {
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))])
  }
  child = undefined
  logs = ''
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  root = undefined
})

describe.skipIf(!enabled)('session deletion Electron synchronization', () => {
  it('broadcasts a successful delete to the detached session window', async () => {
    root = await mkdtemp(join(tmpdir(), 'ola-session-delete-electron-'))
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
    const repository = new BusinessRepository({ path: join(root, 'data.db'), mode: 'direct' })
    await repository.createProject({
      id: 'project-sync-e2e',
      name: 'Project sync before',
      workspaceId: 'local-personal',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    await repository.createSession({
      id: 'delete-sync-e2e',
      title: 'Delete sync E2E session',
      mode: 'chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectId: 'project-sync-e2e',
      workspaceId: 'local-personal'
    })
    await repository.createSession({
      id: 'response-lost-primary-e2e',
      title: 'Response lost primary E2E session',
      mode: 'chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspaceId: 'local-personal'
    })
    await repository.close()
    const databasePath = join(root, 'data.db')
    const failureDatabase = new DatabaseSync(databasePath)
    failureDatabase.exec(`
      CREATE TRIGGER reject_session_delete BEFORE DELETE ON sessions
      WHEN OLD.id = 'delete-sync-e2e'
      BEGIN SELECT RAISE(ABORT, 'injected session delete failure'); END;
    `)
    failureDatabase.close()

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
        env: {
          ...process.env,
          OLA_E2E_DATA_ROOT: root,
          OLA_STRICT_IPC_ALLOWLIST: '1',
          OLA_E2E_SESSION_DELETE_RESPONSE_LOST: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    child.stdout?.on('data', (chunk: Buffer) => (logs += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (logs += chunk.toString()))

    const primary = await connect(
      await pageTarget(port, (url) => url.includes('layoutWindowScope=primary'))
    )
    await call(primary, 'Runtime.enable')
    await waitFor<boolean>(
      primary,
      `Boolean(document.body?.innerText?.length)`,
      Boolean,
      'the primary renderer to mount'
    )
    const registered = await call(primary, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('window:workspace:set', { workspaceId: 'local-personal' })`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(registered.result?.result?.value).toMatchObject({ workspaceId: 'local-personal' })
    const opened = await call(primary, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('session-window:open', 'delete-sync-e2e')`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(opened.result?.result?.value).toMatchObject({ handled: true })

    const detachedUrl = await pageTarget(
      port,
      (url) => url.includes('appView=session') && url.includes('sessionId=delete-sync-e2e')
    )
    const detached = await connect(detachedUrl)
    await call(detached, 'Runtime.enable')
    await waitFor<boolean>(
      detached,
      `document.body.innerText.includes('Delete sync E2E session')`,
      Boolean,
      'the detached session window to display its session'
    )
    await waitFor<boolean>(
      detached,
      `document.body.innerText.includes('Project sync before')`,
      Boolean,
      'the detached session window to display its project'
    )

    const imeCommit = await call(detached, 'Runtime.evaluate', {
      expression: `(() => { const editor = document.querySelector('.composer-editor-content[contenteditable="true"]'); if (!editor) return null; editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); editor.dispatchEvent(enter); return { prevented: enter.defaultPrevented }; })()`,
      returnByValue: true
    })
    expect(imeCommit.result?.result?.value).toEqual({ prevented: false })
    const ordinaryEnter = await call(detached, 'Runtime.evaluate', {
      expression: `(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); const editor = document.querySelector('.composer-editor-content[contenteditable="true"]'); if (!editor) return null; const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); editor.dispatchEvent(enter); return { prevented: enter.defaultPrevented }; })()`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(ordinaryEnter.result?.result?.value).toEqual({ prevented: true })

    const settingsUpdated = await call(primary, 'Runtime.evaluate', {
      expression: `(async () => { const current = await window.ola.ipc.invokeMessagePack('settings:get', 'ola-settings'); return window.ola.ipc.invokeMessagePack('settings:set', { key: 'ola-settings', value: { ...current, state: { ...current.state, fontSize: 18 } } }) })()`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(settingsUpdated.result?.result?.value).toMatchObject({ success: true })
    await waitFor<boolean>(
      detached,
      `document.documentElement.style.getPropertyValue('--app-font-size') === '18px'`,
      Boolean,
      'the detached window to apply a setting saved by the primary window'
    )
    const concurrentSettings = await Promise.all(
      [
        {
          socket: primary,
          patch: { fontSize: 20 },
          nested: { path: ['reasoningEffortByModel', 'model-a'], value: 'high' }
        },
        {
          socket: detached,
          patch: { animationsEnabled: false },
          nested: { path: ['reasoningEffortByModel', 'model-b'], value: 'low' }
        }
      ].map(({ socket, patch, nested }) =>
        call(socket, 'Runtime.evaluate', {
          expression: `window.ola.ipc.invokeMessagePack('settings:set', { key: 'ola-settings', patch: { set: ${JSON.stringify(patch)}, remove: [], setPaths: [${JSON.stringify(nested)}], version: 29 } })`,
          awaitPromise: true,
          returnByValue: true
        })
      )
    )
    expect(concurrentSettings.map((response) => response.result?.result?.value)).toEqual([
      expect.objectContaining({ success: true }),
      expect.objectContaining({ success: true })
    ])
    const mergedSettings = await call(primary, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('settings:get', 'ola-settings')`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(mergedSettings.result?.result?.value).toMatchObject({
      state: {
        fontSize: 20,
        animationsEnabled: false,
        reasoningEffortByModel: { 'model-a': 'high', 'model-b': 'low' }
      }
    })
    for (const socket of [primary, detached]) {
      await waitFor<boolean>(
        socket,
        `document.documentElement.style.getPropertyValue('--app-font-size') === '20px' && document.documentElement.dataset.animations === 'disabled'`,
        Boolean,
        'both windows to apply the merged settings'
      )
    }

    const projectUpdated = await call(primary, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('db:projects:update:msgpack', { id: 'project-sync-e2e', workspaceId: 'local-personal', patch: { name: 'Project sync after', updatedAt: Date.now() } })`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(projectUpdated.result?.result?.value).toMatchObject({ success: true })
    await waitFor<boolean>(
      detached,
      `document.body.innerText.includes('Project sync after')`,
      Boolean,
      'the detached session project name to update without reopening'
    )

    const directoryUpdated = await call(primary, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('db:projects:update:msgpack', { id: 'project-sync-e2e', workspaceId: 'local-personal', patch: { workingFolder: 'C:\\\\project-sync-e2e', sshConnectionId: null, updatedAt: Date.now() } })`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(directoryUpdated.result?.result?.value).toMatchObject({ success: true })
    await waitFor<boolean>(
      detached,
      `document.querySelector('header button[aria-disabled]')?.getAttribute('aria-disabled') === 'false'`,
      Boolean,
      'the detached session working-folder action to become available'
    )

    const concurrentProjectUpdates = await Promise.all(
      [
        { socket: primary, name: 'Concurrent primary' },
        { socket: detached, name: 'Concurrent detached' }
      ].map(({ socket, name }) =>
        call(socket, 'Runtime.evaluate', {
          expression: `window.ola.ipc.invokeMessagePack('db:projects:update:msgpack', { id: 'project-sync-e2e', workspaceId: 'local-personal', patch: { name: '${name}', updatedAt: Date.now() } })`,
          awaitPromise: true,
          returnByValue: true
        })
      )
    )
    expect(concurrentProjectUpdates.map((response) => response.result?.result?.value)).toEqual([
      expect.objectContaining({ success: true }),
      expect.objectContaining({ success: true })
    ])
    const committedProject = await call(primary, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('db:projects:get:msgpack', { id: 'project-sync-e2e', workspaceId: 'local-personal' })`,
      awaitPromise: true,
      returnByValue: true
    })
    const committedName = (committedProject.result?.result?.value as { name: string }).name
    expect(['Concurrent primary', 'Concurrent detached']).toContain(committedName)
    await waitFor<boolean>(
      primary,
      `document.body.innerText.includes(${JSON.stringify(committedName)})`,
      Boolean,
      'the primary window to display the last committed project name'
    )
    await waitFor<boolean>(
      detached,
      `document.body.innerText.includes(${JSON.stringify(committedName)})`,
      Boolean,
      'the detached window to display the last committed project name'
    )

    const modelUpdated = await call(primary, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('db:sessions:update:msgpack', { id: 'delete-sync-e2e', workspaceId: 'local-personal', patch: { providerId: 'e2e-provider', modelId: 'model-sync-e2e', modelSelectionMode: 'manual', updatedAt: Date.now() } })`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(modelUpdated.result?.result?.value).toMatchObject({ success: true })
    await waitFor<boolean>(
      detached,
      `Boolean(document.querySelector('button[aria-label="model-sync-e2e"]'))`,
      Boolean,
      'the detached session model to update without reopening'
    )

    const openDeleteConfirmation = async (): Promise<void> => {
      const menuTrigger = await call(detached, 'Runtime.evaluate', {
        expression: `(() => { const button = document.querySelector('button[aria-label="Conversation actions"], button[aria-label="会话操作"]'); if (!button) return null; const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`,
        returnByValue: true
      })
      const triggerPosition = menuTrigger.result?.result?.value as
        | { x: number; y: number }
        | undefined
      expect(triggerPosition).toBeTruthy()
      await call(detached, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: triggerPosition!.x,
        y: triggerPosition!.y,
        button: 'left',
        clickCount: 1
      })
      await call(detached, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: triggerPosition!.x,
        y: triggerPosition!.y,
        button: 'left',
        clickCount: 1
      })
      await waitFor<boolean>(
        detached,
        `Boolean(Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => /Delete conversation|删除会话/.test(item.textContent || '')))`,
        Boolean,
        'the session delete menu item'
      )
      const deleteItem = await call(detached, 'Runtime.evaluate', {
        expression: `(() => { const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((entry) => /Delete conversation|删除会话/.test(entry.textContent || '')); if (!item) return null; const rect = item.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`,
        returnByValue: true
      })
      const itemPosition = deleteItem.result?.result?.value as { x: number; y: number } | undefined
      expect(itemPosition).toBeTruthy()
      await call(detached, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: itemPosition!.x,
        y: itemPosition!.y,
        button: 'left',
        clickCount: 1
      })
      await call(detached, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: itemPosition!.x,
        y: itemPosition!.y,
        button: 'left',
        clickCount: 1
      })
      await waitFor<boolean>(
        detached,
        `Boolean(document.querySelector('[role="alertdialog"]'))`,
        Boolean,
        'the session delete confirmation'
      )
      await call(detached, 'Runtime.evaluate', {
        expression: `Array.from(document.querySelectorAll('[role="alertdialog"] button')).at(-1)?.click()`,
        returnByValue: true
      })
    }

    await openDeleteConfirmation()
    await waitFor<boolean>(
      detached,
      `document.body.innerText.includes('Could not delete the session. Try again.') || document.body.innerText.includes('删除会话失败，请重试。')`,
      Boolean,
      'visible feedback for the failed session delete'
    )
    const screenshot = await call(detached, 'Page.captureScreenshot', { format: 'png' })
    const screenshotData = (screenshot.result as { data?: string } | undefined)?.data
    expect(screenshotData).toBeTruthy()
    await writeFile(
      join(
        process.cwd(),
        'docs',
        'migrations',
        'ts-runtime',
        'evidence',
        `session-delete-failure-${packagedExe ? 'installed' : 'source'}-2026-10-04.png`
      ),
      Buffer.from(screenshotData!, 'base64')
    )
    expect(logs).toContain('injected session delete failure')
    const stillOpenUrl = await pageTarget(
      port,
      (url) => url.includes('appView=session') && url.includes('sessionId=delete-sync-e2e')
    )
    expect(stillOpenUrl).toBeTruthy()
    await waitFor<boolean>(
      detached,
      `document.body.innerText.includes('Delete sync E2E session')`,
      Boolean,
      'the detached session window to remain after a failed delete'
    )
    const checkDatabase = new DatabaseSync(databasePath)
    try {
      const row = checkDatabase
        .prepare("SELECT COUNT(*) AS count FROM sessions WHERE id = 'delete-sync-e2e'")
        .get() as { count: number }
      expect(row.count).toBe(1)
    } finally {
      checkDatabase.close()
    }

    const primarySessionRow = await waitFor<{ x: number; y: number }>(
      primary,
      `(() => { const button = Array.from(document.querySelectorAll('button')).find((entry) => entry.textContent?.includes('Response lost primary E2E session')); if (!button) return null; const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`,
      (value) => Boolean(value),
      'the primary sidebar session row'
    )
    for (const type of ['mousePressed', 'mouseReleased']) {
      await call(primary, 'Input.dispatchMouseEvent', {
        type,
        x: primarySessionRow.x,
        y: primarySessionRow.y,
        button: 'right',
        clickCount: 1
      })
    }
    const primaryDeleteItem = await waitFor<{ x: number; y: number }>(
      primary,
      `(() => { const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((entry) => /^(Delete|删除)$/.test(entry.textContent?.trim() || '')); if (!item) return null; const rect = item.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`,
      (value) => Boolean(value),
      'the primary sidebar delete menu item'
    )
    for (const type of ['mousePressed', 'mouseReleased']) {
      await call(primary, 'Input.dispatchMouseEvent', {
        type,
        x: primaryDeleteItem.x,
        y: primaryDeleteItem.y,
        button: 'left',
        clickCount: 1
      })
    }
    await waitFor<boolean>(
      primary,
      `Boolean(document.querySelector('[role="alertdialog"]'))`,
      Boolean,
      'the primary sidebar delete confirmation'
    )
    await call(primary, 'Runtime.evaluate', {
      expression: `Array.from(document.querySelectorAll('[role="alertdialog"] button')).at(-1)?.click()`,
      returnByValue: true
    })
    await waitFor<boolean>(
      primary,
      `document.body.innerText.includes('Session deleted') || document.body.innerText.includes('会话已删除')`,
      Boolean,
      'successful feedback after the primary delete response was lost'
    )
    const primaryScreenshot = await call(primary, 'Page.captureScreenshot', { format: 'png' })
    const primaryScreenshotData = (primaryScreenshot.result as { data?: string } | undefined)?.data
    expect(primaryScreenshotData).toBeTruthy()
    await writeFile(
      join(
        process.cwd(),
        'docs',
        'migrations',
        'ts-runtime',
        'evidence',
        `session-delete-response-lost-primary-${packagedExe ? 'installed' : 'source'}-2026-10-04.png`
      ),
      Buffer.from(primaryScreenshotData!, 'base64')
    )
    await waitFor<boolean>(
      primary,
      `!document.body.innerText.includes('Response lost primary E2E session')`,
      Boolean,
      'the committed primary session to disappear from the sidebar'
    )
    expect(logs).toContain('injected session delete response loss')
    const responseLostDatabase = new DatabaseSync(databasePath)
    try {
      const row = responseLostDatabase
        .prepare("SELECT COUNT(*) AS count FROM sessions WHERE id = 'response-lost-primary-e2e'")
        .get() as { count: number }
      expect(row.count).toBe(0)
      responseLostDatabase.exec('DROP TRIGGER reject_session_delete')
    } finally {
      responseLostDatabase.close()
    }

    await openDeleteConfirmation()
    await waitUntilNoPage(
      port,
      (url) => url.includes('appView=session') && url.includes('sessionId=delete-sync-e2e')
    )
    expect(logs).toContain('injected session delete response loss')
    const committedDatabase = new DatabaseSync(databasePath)
    try {
      const row = committedDatabase
        .prepare("SELECT COUNT(*) AS count FROM sessions WHERE id = 'delete-sync-e2e'")
        .get() as { count: number }
      expect(row.count).toBe(0)
    } finally {
      committedDatabase.close()
    }
  }, 90_000)
})
