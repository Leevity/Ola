import { once } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'

const require = createRequire(import.meta.url)
const electronBinary = require('electron') as string
const WebSocket = require('ws') as {
  new (url: string): DevToolsSocket
  OPEN: number
}
const enabled = process.env.RUN_SESSION_CREATE_ELECTRON_E2E === '1'
type DevToolsSocket = {
  readyState: number
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

async function call(
  method: string,
  params: Record<string, unknown> = {}
): Promise<{ result?: { value?: unknown } }> {
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
        result?: { result?: { value?: unknown } }
      }
      if (message.id !== id) return
      clearTimeout(timer)
      target.off('message', onMessage)
      if (message.error) reject(new Error(`${method}: ${message.error.message}`))
      else resolveCall(message.result ?? {})
    }
    target.on('message', onMessage)
    target.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate<T>(expression: string): Promise<T | undefined> {
  const response = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  return response.result?.value as T | undefined
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
  const page = await evaluate(
    `({ hash: location.hash, body: document.body.innerText.slice(-700), draft: document.querySelector('.composer-editor-content')?.innerText, disabled: document.querySelector('button.composer-send')?.disabled })`
  )
  throw new Error(
    `Timed out waiting for ${description}; last=${JSON.stringify(last)}; page=${JSON.stringify(page)}; logs=${logs.slice(-3000)}`
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
          await call('Runtime.enable')
          return
        }
      }
    } catch {
      // Main and Renderer may still be starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`Timed out waiting for Electron primary page; logs=${logs.slice(-3000)}`)
}

afterEach(async () => {
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
  logs = ''
  if (root) {
    const target = resolve(root)
    const temporaryRoot = resolve(tmpdir()) + sep
    if (!target.startsWith(temporaryRoot))
      throw new Error('Refusing to remove a non-temporary E2E root')
    await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
  root = undefined
})

describe.skipIf(!enabled)('session creation failure in Electron', () => {
  it('retains the home composer draft after a database failure and retries after recovery', async () => {
    root = await mkdtemp(join(tmpdir(), 'ola-session-create-electron-'))
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
    await repository.close()
    const database = new DatabaseSync(join(root, 'data.db'))
    database.exec(`
      CREATE TRIGGER reject_session_create BEFORE INSERT ON sessions
      BEGIN SELECT RAISE(ABORT, 'injected session create failure'); END;
    `)
    database.close()

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
      `Boolean(document.querySelector('.composer-editor-content[role="textbox"]'))`,
      Boolean,
      'the home composer'
    )
    await evaluate(`document.querySelector('.composer-editor-content[role="textbox"]').focus()`)
    await call('Input.insertText', { text: 'Session create E2E draft' })
    await waitFor<boolean>(
      `document.querySelector('.composer-editor-content')?.innerText?.includes('Session create E2E draft')`,
      Boolean,
      'the typed draft'
    )
    await evaluate(`document.querySelector('button.composer-send')?.click()`)
    await waitFor<boolean>(
      `document.body.innerText.includes('Send failed. Your draft was kept.') || document.body.innerText.includes('发送失败，草稿已保留。')`,
      Boolean,
      'visible feedback for the failed create'
    )
    await waitFor<boolean>(
      `location.hash.includes('/chat/') === false && document.querySelector('.composer-editor-content')?.innerText?.includes('Session create E2E draft')`,
      Boolean,
      'the retained draft on the home page after the failed create'
    )
    expect(logs).not.toContain('[SessionQueue] Failed to restore queued messages')

    const failedRows = await evaluate<Array<{ id: string }>>(
      `window.ola.ipc.invokeMessagePack('db:sessions:list:msgpack', { workspaceId: 'local-personal' })`
    )
    expect(failedRows).toHaveLength(0)

    const recovered = new DatabaseSync(join(root, 'data.db'))
    recovered.exec('DROP TRIGGER reject_session_create')
    recovered.close()
    const retryState = await evaluate<{
      disabled: boolean
      draft: string
      body: string
    }>(
      `({ disabled: document.querySelector('button.composer-send')?.disabled, draft: document.querySelector('.composer-editor-content')?.innerText, body: document.body.innerText.slice(-500) })`
    )
    expect(retryState?.disabled, JSON.stringify(retryState)).toBe(false)
    await evaluate(`document.querySelector('button.composer-send')?.click()`)
    const sessionId = await waitFor<string>(
      `location.hash.includes('/session/') ? location.hash.split('/session/')[1].split('?')[0] : (location.hash.includes('/chat/') ? location.hash.split('/chat/')[1].split('?')[0] : '')`,
      (value) => Boolean(value),
      'navigation to the persisted session after retry'
    )
    const successfulRows = await evaluate<Array<{ id: string }>>(
      `window.ola.ipc.invokeMessagePack('db:sessions:list:msgpack', { workspaceId: 'local-personal' })`
    )
    expect(successfulRows?.filter((row) => row.id === sessionId)).toHaveLength(1)
  }, 90_000)

  it('uses the committed session after its IPC response is lost', async () => {
    root = await mkdtemp(join(tmpdir(), 'ola-session-response-lost-electron-'))
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
          OLA_E2E_SESSION_CREATE_RESPONSE_LOST: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    child.stdout?.on('data', (chunk: Buffer) => (logs += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (logs += chunk.toString()))
    await connect(port)
    await waitFor<boolean>(
      `Boolean(document.querySelector('.composer-editor-content[role="textbox"]'))`,
      Boolean,
      'the home composer'
    )
    await evaluate(`document.querySelector('.composer-editor-content[role="textbox"]').focus()`)
    await call('Input.insertText', { text: 'Committed session response lost E2E' })
    await waitFor<boolean>(
      `document.querySelector('.composer-editor-content')?.innerText?.includes('Committed session response lost E2E')`,
      Boolean,
      'the typed draft'
    )
    await evaluate(`document.querySelector('button.composer-send')?.click()`)
    const sessionId = await waitFor<string>(
      `location.hash.includes('/session/') ? location.hash.split('/session/')[1].split('?')[0] : (location.hash.includes('/chat/') ? location.hash.split('/chat/')[1].split('?')[0] : '')`,
      (value) => Boolean(value),
      'navigation to the committed session after its create response was lost'
    )
    expect(logs).toContain('injected session create response loss')
    const persistedRows = await evaluate<Array<{ id: string }>>(
      `window.ola.ipc.invokeMessagePack('db:sessions:list:msgpack', { workspaceId: 'local-personal' })`
    )
    expect(persistedRows?.filter((row) => row.id === sessionId)).toHaveLength(1)
    expect(persistedRows).toHaveLength(1)
  }, 90_000)
})
