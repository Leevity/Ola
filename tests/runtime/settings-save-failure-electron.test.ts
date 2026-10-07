import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const electronBinary = require('electron') as string
const WebSocket = require('ws') as { new (url: string): DevToolsSocket }
const enabled = process.env.RUN_SETTINGS_SAVE_ELECTRON_E2E === '1'
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
let forcedStopCount = 0
let apiServer: Server | undefined

async function call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
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
      else resolveCall(message.result?.result?.value)
    }
    target.on('message', onMessage)
    target.send(JSON.stringify({ id, method, params }))
  })
}

async function captureScreenshot(path: string): Promise<void> {
  if (!socket) throw new Error('Electron DevTools connection is not open')
  const target = socket
  const id = Math.floor(Math.random() * 1_000_000_000)
  const data = await new Promise<string>((resolveCapture, reject) => {
    const timer = setTimeout(() => {
      target.off('message', onMessage)
      reject(new Error('Timed out waiting for Page.captureScreenshot'))
    }, 12_000)
    const onMessage = (raw: Buffer | string): void => {
      const message = JSON.parse(raw.toString()) as {
        id?: number
        error?: { message: string }
        result?: { data?: string }
      }
      if (message.id !== id) return
      clearTimeout(timer)
      target.off('message', onMessage)
      if (message.error || !message.result?.data) {
        reject(new Error(message.error?.message ?? 'Screenshot data missing'))
      } else resolveCapture(message.result.data)
    }
    target.on('message', onMessage)
    target.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } }))
  })
  await writeFile(path, Buffer.from(data, 'base64'))
}

async function evaluate<T>(expression: string): Promise<T | undefined> {
  return (await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })) as T | undefined
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
  const state = await evaluate(
    `({ body: document.body.innerText.slice(-1000), hash: location.hash, buttons: [...document.querySelectorAll('button')].map((button) => ({ text: button.innerText, title: button.title, aria: button.getAttribute('aria-label') })).filter((button) => /设置|Settings/i.test(button.text + button.title + button.aria)).slice(0, 15) })`
  )
  throw new Error(
    `Timed out waiting for ${description}; last=${JSON.stringify(last)}; state=${JSON.stringify(state)}; logs=${logs.slice(-3000)}`
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
  await waitFor<boolean>(`Boolean(document.body?.innerText)`, Boolean, 'the primary renderer')
}

async function stopApp(graceful = true): Promise<void> {
  if (child && child.exitCode === null) {
    if (graceful && socket) {
      try {
        await Promise.race([
          call('Browser.close'),
          new Promise((resolveWait) => setTimeout(resolveWait, 2_000))
        ])
      } catch {
        // Continue to the process fallback if CDP closes before replying.
      }
    }
    if (graceful) {
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolveWait) => setTimeout(resolveWait, 5_000))
      ])
    }
    if (child.exitCode === null) {
      forcedStopCount += 1
      child.kill('SIGTERM')
      if (child.exitCode === null) {
        await Promise.race([
          once(child, 'exit'),
          new Promise((resolveWait) => setTimeout(resolveWait, 3_000))
        ])
      }
    }
  }
  socket?.close()
  socket = undefined
  child = undefined
}

afterEach(async () => {
  await stopApp()
  if (apiServer) {
    apiServer.closeAllConnections()
    await new Promise<void>((resolveClose) => apiServer!.close(() => resolveClose()))
    apiServer = undefined
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

describe.skipIf(!enabled)('settings save failure in Electron', () => {
  it('shows failure, retries the current value, and reloads it after restart', async () => {
    root = await mkdtemp(join(tmpdir(), 'ola-settings-save-electron-'))
    await writeFile(join(root, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n', 'utf8')
    const settingsPath = join(root, 'settings.json')
    const backupPath = join(root, 'settings.backup.json')
    const codegraphFixture = join(root, 'codegraph-smoke')
    await mkdir(codegraphFixture)
    await writeFile(
      join(codegraphFixture, 'main.ts'),
      "export function olaCodegraphSmoke(): string { return 'ready' }\n",
      'utf8'
    )
    await writeFile(
      settingsPath,
      JSON.stringify({
        'ola-settings': {
          state: { onboardingCompleted: true, onboardingCompletedAt: Date.now(), fontSize: 16 },
          version: 29
        }
      }),
      'utf8'
    )
    await startApp()
    if (process.env.OLA_E2E_REMOTE_ACCOUNT_CRASH === '1') {
      let workspaceRequests = 0
      const meshPublicKeys: string[] = []
      apiServer = createServer((request, response) => {
        response.setHeader('content-type', 'application/json')
        if (request.url === '/api/auth/login' && request.method === 'POST') {
          response.end(
            JSON.stringify({ token: 'ola-e2e-remote-token', account: { id: 'account-e2e' } })
          )
          return
        }
        if (
          request.url === '/api/account/workspaces' &&
          request.headers.authorization === 'Bearer ola-e2e-remote-token'
        ) {
          workspaceRequests += 1
          response.end(JSON.stringify({ workspaces: [{ id: 'personal-e2e', kind: 'personal' }] }))
          return
        }
        if (request.url === '/api/devices/register' && request.method === 'POST') {
          response.end(JSON.stringify({ device: { id: 'device-e2e' } }))
          return
        }
        if (request.url === '/api/devices/device-e2e/signaling-token') {
          response.end(JSON.stringify({ token: 'ola-e2e-device-token' }))
          return
        }
        if (request.url === '/api/mesh/v1/nodes/register' && request.method === 'POST') {
          let body = ''
          request.on('data', (chunk: Buffer) => (body += chunk.toString()))
          request.on('end', () => {
            const registration = JSON.parse(body) as { publicKey?: string }
            if (typeof registration.publicKey === 'string') {
              meshPublicKeys.push(registration.publicKey)
            }
            response.end(JSON.stringify({ node: { id: 'node-e2e' } }))
          })
          return
        }
        response.writeHead(404)
        response.end(JSON.stringify({ error: 'not found' }))
      })
      apiServer.listen(0, '127.0.0.1')
      await once(apiServer, 'listening')
      const address = apiServer.address()
      if (!address || typeof address === 'string') throw new Error('Missing test API port')
      const apiBaseUrl = `http://127.0.0.1:${address.port}`
      const loggedIn = await evaluate<{ account?: { id?: string }; error?: string }>(
        `window.ola.ipc.invokeMessagePack('remote:account:invoke', {
          apiBaseUrl: ${JSON.stringify(apiBaseUrl)}, operation: 'login',
          payload: { email: 'ola-e2e@example.invalid', password: 'test-password' }
        })`
      )
      expect(loggedIn?.account?.id, JSON.stringify(loggedIn)).toBe('account-e2e')
      const registeredDevice = await evaluate<{ device?: { id?: string } }>(
        `window.ola.ipc.invokeMessagePack('remote:account:invoke', {
          apiBaseUrl: ${JSON.stringify(apiBaseUrl)}, operation: 'device-register',
          payload: { deviceName: 'e2e-device', platform: 'windows', fingerprint: 'e2e-fingerprint' }
        })`
      )
      expect(registeredDevice?.device?.id).toBe('device-e2e')
      const registerMesh = `window.ola.ipc.invokeMessagePack('remote:account:invoke', {
        apiBaseUrl: ${JSON.stringify(apiBaseUrl)}, operation: 'mesh-node-register',
        payload: { deviceId: 'device-e2e' }
      })`
      const firstNode = await evaluate<{ node?: { id?: string } }>(registerMesh)
      expect(firstNode?.node?.id).toBe('node-e2e')
      expect(meshPublicKeys).toHaveLength(1)
      const encrypted = await readFile(join(root, 'electron-user-data', 'remote-auth.bin'))
      expect(encrypted.toString()).not.toContain('ola-e2e-remote-token')
      const encryptedIdentity = await readFile(
        join(root, 'electron-user-data', 'mesh-node-identity.bin')
      )
      expect(encryptedIdentity.toString()).not.toContain(meshPublicKeys[0])
      const localState = JSON.parse(
        await readFile(join(root, 'electron-user-data', 'session-data', 'Local State'), 'utf8')
      ) as { os_crypt?: { encrypted_key?: unknown } }
      expect(typeof localState.os_crypt?.encrypted_key).toBe('string')
      await stopApp(false)
      expect(forcedStopCount).toBe(1)
      await startApp()
      const directory = await evaluate<{ workspaces?: Array<{ id?: string }> }>(
        `window.ola.ipc.invokeMessagePack('remote:account:invoke', {
          apiBaseUrl: ${JSON.stringify(apiBaseUrl)}, operation: 'workspace-list', payload: {}
        })`
      )
      expect(directory?.workspaces?.[0]?.id).toBe('personal-e2e')
      expect(workspaceRequests).toBeGreaterThan(0)
      const secondNode = await evaluate<{ node?: { id?: string } }>(registerMesh)
      expect(secondNode?.node?.id).toBe('node-e2e')
      expect(meshPublicKeys).toHaveLength(2)
      expect(meshPublicKeys[1]).toBe(meshPublicKeys[0])
      return
    }
    if (process.env.OLA_E2E_PENDING_OAUTH_CRASH === '1') {
      apiServer = createServer((request, response) => {
        response.setHeader('content-type', 'application/json')
        if (request.url === '/api/oauth/token' && request.method === 'POST') {
          response.end(
            JSON.stringify({ access_token: 'ola-e2e-oauth-token', account: { id: 'oauth-e2e' } })
          )
          return
        }
        response.writeHead(404)
        response.end(JSON.stringify({ error: 'not found' }))
      })
      apiServer.listen(0, '127.0.0.1')
      await once(apiServer, 'listening')
      const address = apiServer.address()
      if (!address || typeof address === 'string') throw new Error('Missing test OAuth port')
      const apiBaseUrl = `http://127.0.0.1:${address.port}`
      const started = await evaluate<{ started?: boolean; authorizeUrl?: string }>(
        `window.ola.ipc.invokeMessagePack('remote:account:invoke', {
          apiBaseUrl: ${JSON.stringify(apiBaseUrl)}, operation: 'oauth-start', payload: {}
        })`
      )
      expect(started?.started).toBe(true)
      const state = new URL(started?.authorizeUrl ?? '').searchParams.get('state')
      expect(state).toBeTruthy()
      const pending = await readFile(join(root, 'electron-user-data', 'remote-oauth-pending.bin'))
      expect(pending.toString()).not.toContain(state)
      const localState = JSON.parse(
        await readFile(join(root, 'electron-user-data', 'session-data', 'Local State'), 'utf8')
      ) as { os_crypt?: { encrypted_key?: unknown } }
      expect(typeof localState.os_crypt?.encrypted_key).toBe('string')
      await stopApp(false)
      expect(forcedStopCount).toBe(1)
      await startApp()
      const callbackUrl = `ola://auth/callback?code=e2e-code&state=${encodeURIComponent(state ?? '')}`
      const completed = await evaluate<{ account?: { id?: string } }>(
        `window.ola.ipc.invokeMessagePack('remote:account:invoke', {
          apiBaseUrl: ${JSON.stringify(apiBaseUrl)}, operation: 'oauth-callback',
          payload: { callbackUrl: ${JSON.stringify(callbackUrl)} }
        })`
      )
      expect(completed?.account?.id).toBe('oauth-e2e')
      return
    }
    if (process.env.OLA_E2E_COOKIE_ARCHIVE_CRASH === '1') {
      apiServer = createServer((_request, response) => {
        response.setHeader(
          'set-cookie',
          'ola-e2e-cookie=isolated-value; Path=/; HttpOnly; SameSite=Lax'
        )
        response.end('Cookie fixture')
      })
      apiServer.listen(0, '127.0.0.1')
      await once(apiServer, 'listening')
      const address = apiServer.address()
      if (!address || typeof address === 'string') throw new Error('Missing cookie fixture port')
      const cookieUrl = `http://127.0.0.1:${address.port}/fixture`
      const browserStatus = await evaluate<{
        success?: boolean
        status?: { reuseEnabled?: boolean }
      }>(`window.ola.ipc.invokeMessagePack('browser:emulation-status', {})`)
      expect(browserStatus?.success).toBe(true)
      const reuseEnabled = browserStatus?.status?.reuseEnabled === true
      const created = await evaluate<{ success?: boolean; error?: string }>(
        `window.ola.ipc.invokeMessagePack('browser:view-create', {
          tabId: 'cookie-archive-fixture', workspaceId: 'local-personal',
          profileId: ${JSON.stringify(reuseEnabled ? 'external-user-data' : 'persist:ola-browser')},
          ${reuseEnabled ? '' : "partition: 'persist:ola-browser',"}
          bounds: { x: 1, y: 1, width: 10, height: 10 }, url: ${JSON.stringify(cookieUrl)}
        })`
      )
      expect(created?.success, created?.error).toBe(true)
      const destroyed = await evaluate<{
        success?: boolean
      }>(`window.ola.ipc.invokeMessagePack('browser:view-destroy', {
        tabId: 'cookie-archive-fixture'
      })`)
      expect(destroyed?.success).toBe(true)
      const exported = await evaluate<{ success?: boolean; exported?: number; error?: string }>(
        `window.ola.ipc.invokeMessagePack('browser:export-cookies', {
          workspaceId: 'local-personal'
        })`
      )
      expect(exported?.success, JSON.stringify(exported)).toBe(true)
      expect(exported?.exported).toBe(1)
      const archiveText = await readFile(join(root, 'cookie-export.ola-cookies'), 'utf8')
      expect(archiveText).not.toContain('isolated-value')
      const archive = JSON.parse(archiveText) as {
        encryption?: string
        ciphertext?: string
      }
      expect(archive.encryption).toBe('electron-safe-storage')
      expect(typeof archive.ciphertext).toBe('string')
      await stopApp(false)
      expect(forcedStopCount).toBe(1)

      const probePath = join(root, 'decrypt-cookie-archive.cjs')
      const probeResultPath = join(root, 'decrypt-cookie-result.json')
      await writeFile(
        probePath,
        `const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const root = ${JSON.stringify(root)}
app.setPath('userData', path.join(root, 'electron-user-data'))
app.setPath('sessionData', path.join(root, 'electron-user-data', 'session-data'))
app.whenReady().then(() => {
  const archive = JSON.parse(fs.readFileSync(path.join(root, 'cookie-export.ola-cookies'), 'utf8'))
  const payload = JSON.parse(safeStorage.decryptString(Buffer.from(archive.ciphertext, 'base64')))
  fs.writeFileSync(${JSON.stringify(probeResultPath)}, JSON.stringify({
    workspaceId: payload.workspaceId,
    cookieCount: payload.cookies.length,
    cookies: payload.cookies.map((cookie) => ({
      name: cookie.name, value: cookie.value, domain: cookie.domain
    }))
  }))
  app.exit(0)
}).catch((error) => { console.error(error); app.exit(1) })
`
      )
      const probe = spawn(electronBinary, [probePath, '--no-sandbox'], {
        cwd: process.cwd(),
        env: { ...process.env, OLA_E2E_DATA_ROOT: root },
        stdio: ['ignore', 'ignore', 'pipe']
      })
      let probeError = ''
      probe.stderr?.on('data', (chunk: Buffer) => (probeError += chunk.toString()))
      const timeout = setTimeout(() => probe.kill('SIGTERM'), 15_000)
      try {
        const [exitCode] = (await once(probe, 'exit')) as [number | null]
        expect(exitCode, probeError.slice(-1000)).toBe(0)
      } finally {
        clearTimeout(timeout)
      }
      const decrypted = JSON.parse(await readFile(probeResultPath, 'utf8')) as {
        workspaceId?: string
        cookieCount?: number
        cookies?: Array<{ name: string; value: string; domain: string }>
      }
      expect(decrypted.workspaceId).toBe('local-personal')
      expect(decrypted.cookieCount).toBe(exported?.exported)
      expect(decrypted.cookies).toEqual([
        { name: 'ola-e2e-cookie', value: 'isolated-value', domain: '127.0.0.1' }
      ])
      return
    }
    if (process.env.OLA_E2E_CREDENTIAL_CRASH === '1') {
      const stored = await evaluate<{ success: boolean; ref?: { id: string }; error?: string }>(
        `window.ola.ipc.invokeMessagePack('credentials:store', {
          domain: 'example.invalid', username: 'ola-e2e',
          password: 'ola-e2e-credential-secret'
        })`
      )
      expect(stored?.success, JSON.stringify(stored)).toBe(true)
      const vaultBytes = await readFile(
        join(root, 'electron-user-data', 'credentials', 'vault.bin')
      )
      expect(vaultBytes.toString()).not.toContain('ola-e2e-credential-secret')
      const localState = JSON.parse(
        await readFile(join(root, 'electron-user-data', 'session-data', 'Local State'), 'utf8')
      ) as { os_crypt?: { encrypted_key?: unknown } }
      expect(typeof localState.os_crypt?.encrypted_key).toBe('string')
      await stopApp(false)
      expect(forcedStopCount).toBe(1)
      await startApp()
      const updated = await evaluate<{ ref?: { id: string }; error?: string }>(
        `window.ola.ipc.invokeMessagePack('credentials:update', {
          id: ${JSON.stringify(stored?.ref?.id)}, password: 'ola-e2e-recovered-secret'
        })`
      )
      expect(updated?.ref?.id, JSON.stringify(updated)).toBe(stored?.ref?.id)
      return
    }
    await waitFor<boolean>(
      `Boolean([...document.querySelectorAll('button')].find((button) => button.innerText.includes('未配置 API Key')))`,
      Boolean,
      'the settings entry'
    )
    await evaluate(
      `[...document.querySelectorAll('button')].find((button) => button.innerText.includes('未配置 API Key')).click()`
    )
    await waitFor<boolean>(`Boolean(document.querySelector('.settings-page'))`, Boolean, 'settings')
    await evaluate(`document.querySelector('.settings-page button[title="通用设置"]').click()`)
    const original = await evaluate<string>(
      `document.querySelector('.settings-page input[type="number"].max-w-32')?.value`
    )
    expect(original).toBe('16')
    const fontMetricsExpression = `(() => {
      const input = document.querySelector('.settings-page input[type="number"].max-w-32')
      const description = input?.parentElement?.querySelector('p')
      return {
        root: parseFloat(getComputedStyle(document.documentElement).fontSize),
        description: description ? parseFloat(getComputedStyle(description).fontSize) : 0
      }
    })()`
    const initialFontMetrics = await waitFor<{ root: number; description: number }>(
      fontMetricsExpression,
      (metrics) => metrics?.root === 16 && metrics.description > 0,
      'the initial settings font metrics'
    )
    expect(initialFontMetrics.description).toBeCloseTo(13, 2)
    const generalForm = await evaluate<{
      unnamed: string[]
      undescribed: string[]
      sliderName: string
    }>(`(() => {
      const ids = [
        'settings-auto-update', 'settings-project-directory-custom',
        'settings-project-directory', 'settings-font-family', 'settings-font-size',
        'settings-animations', 'settings-toolbar-collapsed', 'settings-runs-collapsed',
        'settings-tool-density', 'settings-language'
      ]
      const unnamed = ids.filter((id) => {
        const control = document.getElementById(id)
        return !control || !(control.labels?.[0]?.textContent?.trim() || control.getAttribute('aria-label'))
      })
      const describedIds = ids.filter((id) => id !== 'settings-project-directory')
      const undescribed = describedIds.filter((id) => {
        const control = document.getElementById(id)
        const descriptionId = control?.getAttribute('aria-describedby')
        return !descriptionId || !document.getElementById(descriptionId)?.textContent?.trim()
      })
      const slider = document.querySelector('.settings-page [role="slider"]')
      return { unnamed, undescribed, sliderName: slider?.getAttribute('aria-label') ?? '' }
    })()`)
    expect(generalForm?.unnamed).toEqual([])
    expect(generalForm?.undescribed).toEqual([])
    expect(generalForm?.sliderName).toBe('字体大小')
    const screenshotDir = process.env.OLA_E2E_SETTINGS_SCREENSHOT_DIR
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true })
      await captureScreenshot(join(screenshotDir, '00-general-100-percent.png'))
    }
    for (const zoom of [1, 1.25, 1.5]) {
      await call('Emulation.setDeviceMetricsOverride', {
        width: Math.round(760 / zoom),
        height: Math.round(560 / zoom),
        deviceScaleFactor: zoom,
        mobile: false
      })
      const layout = await waitFor<{
        viewportWidth: number
        documentWidth: number
        sidebarWidth: number
        contentWidth: number
        inputRight: number
        navButtonLabel: string
        navButtonWidth: number
      }>(
        `(() => {
          const sidebar = document.querySelector('.settings-page nav')?.parentElement
          const content = sidebar?.nextElementSibling
          const input = document.querySelector('.settings-page input[type="number"].max-w-32')
          const navButton = sidebar?.querySelector('nav button')
          return {
            viewportWidth: innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            sidebarWidth: sidebar?.getBoundingClientRect().width ?? 0,
            contentWidth: content?.getBoundingClientRect().width ?? 0,
            inputRight: input?.getBoundingClientRect().right ?? Infinity,
            navButtonLabel: navButton?.getAttribute('aria-label') ?? '',
            navButtonWidth: navButton?.getBoundingClientRect().width ?? 0
          }
        })()`,
        (value) => Boolean(value && value.contentWidth > 0),
        `the settings layout at ${zoom * 100}% equivalent zoom`
      )
      expect(layout.documentWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewportWidth)
      expect(layout.contentWidth, JSON.stringify(layout)).toBeGreaterThanOrEqual(280)
      expect(layout.inputRight, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewportWidth)
      expect(layout.navButtonLabel).not.toBe('')
      expect(layout.navButtonWidth).toBeGreaterThanOrEqual(32)
    }
    const settingsPages = await evaluate<string[]>(
      `[...document.querySelectorAll('.settings-page nav button[title]')].map((button) => button.title)`
    )
    expect(settingsPages?.length).toBeGreaterThanOrEqual(20)
    const responsivePages: Array<{
      title: string
      viewportWidth: number
      documentWidth: number
      contentWidth: number
      outOfBounds: string[]
      smallText: string[]
      missingDescriptionTargets: string[]
    }> = []
    for (const [index, title] of (settingsPages ?? []).entries()) {
      await evaluate(
        `[...document.querySelectorAll('.settings-page nav button')].find((button) => button.title === ${JSON.stringify(title)})?.click()`
      )
      await waitFor<boolean>(
        `[...document.querySelectorAll('.settings-page nav button')].some((button) => button.title === ${JSON.stringify(title)} && button.getAttribute('aria-current') === 'page')`,
        Boolean,
        `the ${title} settings page to become active`
      )
      await new Promise((resolveWait) => setTimeout(resolveWait, 200))
      await evaluate(`(() => {
        const sidebar = document.querySelector('.settings-page nav')?.parentElement
        const content = sidebar?.nextElementSibling
        content?.scrollTo(0, 0)
        for (const scroller of content?.querySelectorAll('*') ?? []) {
          if (scroller.scrollTop > 0) scroller.scrollTop = 0
        }
      })()`)
      const unhandledErrors = await evaluate<string[]>(
        `[...document.querySelectorAll('[data-sonner-toast]')].filter((toast) => /未处理的错误|Unhandled error/i.test(toast.textContent ?? '')).map((toast) => toast.textContent?.trim().slice(0, 300) ?? '')`
      )
      expect(unhandledErrors, `unhandled error while opening ${title}`).toEqual([])
      if (title === '模型配置') {
        const temperatureSlider = await evaluate<{
          label: string
          description: string | null
        }>(`(() => {
          const slider = document.querySelector('.settings-page [role="slider"]')
          return {
            label: document.getElementById(slider?.getAttribute('aria-labelledby') ?? '')?.textContent?.trim() ?? '',
            description: slider?.getAttribute('aria-describedby') ?? null
          }
        })()`)
        expect(temperatureSlider?.label).toBe('温度')
        expect(temperatureSlider?.description).toBe('settings-model-temperature-description')
      }
      if (title === '项目智能') {
        const grammarStatus = await evaluate<{
          expected: number
          available: number
          missing: string[]
        }>(
          `window.ola.ipc.invokeMessagePack('codegraph:status').then((status) => status.grammarStatus)`
        )
        expect(grammarStatus?.expected).toBe(18)
        expect(grammarStatus?.available).toBe(18)
        expect(grammarStatus?.missing).toEqual([])
        const indexResult = await evaluate<{
          success?: boolean
          state?: string
          filesIndexed?: number
        }>(
          `window.ola.ipc.invokeMessagePack('codegraph:request', { method: 'codegraph/index', params: { workingFolder: ${JSON.stringify(codegraphFixture)} } })`
        )
        expect(indexResult?.success).toBe(true)
        expect(indexResult?.state).toBe('complete')
        expect(indexResult?.filesIndexed).toBeGreaterThanOrEqual(1)
      }
      if (screenshotDir) {
        await captureScreenshot(
          join(screenshotDir, `${String(index + 1).padStart(2, '0')}-settings-page.png`)
        )
      }
      if (title === '频道') {
        const narrowListVisible = await evaluate<boolean>(`(() => {
          const list = document.querySelector('.channel-settings-list')
          const detail = document.querySelector('.channel-settings-detail')
          return Boolean(list?.getClientRects().length && !detail?.getClientRects().length)
        })()`)
        expect(narrowListVisible).toBe(true)
        const channelRowFocused = await evaluate<boolean>(`(() => {
          const row = document.querySelector('.channel-settings-list [role="button"]')
          row?.focus()
          return document.activeElement === row
        })()`)
        expect(channelRowFocused).toBe(true)
        await call('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13
        })
        await call('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13
        })
        await waitFor<boolean>(
          `Boolean(document.querySelector('.channel-settings-detail')?.getClientRects().length && !document.querySelector('.channel-settings-list')?.getClientRects().length)`,
          Boolean,
          'the narrow channel configuration pane'
        )
        expect(
          await evaluate<string>(
            `document.querySelector('.channel-settings-detail h3')?.textContent?.trim() ?? ''`
          )
        ).toBe('飞书机器人')
        if (screenshotDir) {
          await captureScreenshot(join(screenshotDir, '16-channel-config.png'))
        }
      }
      const pageLayout = await evaluate<{
        viewportWidth: number
        documentWidth: number
        contentWidth: number
        outOfBounds: string[]
        smallText: string[]
        missingDescriptionTargets: string[]
      }>(`(() => {
        const sidebar = document.querySelector('.settings-page nav')?.parentElement
        const content = sidebar?.nextElementSibling
        const controls = [...(content?.querySelectorAll('button, input, select, textarea') ?? [])]
        const outOfBounds = controls.filter((control) => {
          const rect = control.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0 && rect.right > innerWidth + 1
        }).slice(0, 5).map((control) => control.getAttribute('aria-label') || control.textContent?.trim().slice(0, 40) || control.tagName)
        const smallText = [...(content?.querySelectorAll('p, span, label, button') ?? [])]
          .filter((element) => {
            const rect = element.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility === 'visible' &&
              Boolean(element.textContent?.trim()) && parseFloat(getComputedStyle(element).fontSize) < 12
          })
          .slice(0, 10)
          .map((element) => getComputedStyle(element).fontSize + ' ' + element.textContent.trim().slice(0, 40))
        const missingDescriptionTargets = [...(content?.querySelectorAll('[aria-labelledby], [aria-describedby]') ?? [])]
          .flatMap((element) => ['aria-labelledby', 'aria-describedby'].flatMap((attribute) =>
            (element.getAttribute(attribute) ?? '').split(/\\s+/).filter((id) => id && !document.getElementById(id))
              .map((id) => element.tagName + '[' + attribute + '=' + id + ']')
          ))
          .slice(0, 10)
        return {
          viewportWidth: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          contentWidth: content?.getBoundingClientRect().width ?? 0,
          outOfBounds,
          smallText,
          missingDescriptionTargets
        }
      })()`)
      if (!pageLayout) throw new Error(`Missing layout for ${title}`)
      responsivePages.push({ title, ...pageLayout })
    }
    if (process.env.OLA_E2E_SETTINGS_AUDIT_FILE) {
      await writeFile(
        process.env.OLA_E2E_SETTINGS_AUDIT_FILE,
        JSON.stringify(responsivePages, null, 2),
        'utf8'
      )
    }
    expect(
      responsivePages.filter(
        (page) =>
          page.documentWidth > page.viewportWidth ||
          page.contentWidth < 280 ||
          page.outOfBounds.length > 0 ||
          page.smallText.length > 0 ||
          page.missingDescriptionTargets.length > 0
      )
    ).toEqual([])
    await evaluate(
      `document.querySelector('.settings-page nav button[title="AI 服务商"]')?.click()`
    )
    await waitFor<boolean>(
      `Boolean([...document.querySelectorAll('.provider-settings-list button')].find((button) => button.textContent?.includes('Codex (OAuth)')))`,
      Boolean,
      'the Codex OAuth provider in settings'
    )
    await evaluate(
      `([...document.querySelectorAll('.provider-settings-list button')].find((button) => button.textContent?.includes('Codex (OAuth)')))?.click()`
    )
    await waitFor<boolean>(
      `Boolean([...document.querySelectorAll('.settings-page button')].find((button) => button.textContent?.includes('粘贴 JSON')))`,
      Boolean,
      'the OAuth account JSON import entry'
    )
    await evaluate(
      `([...document.querySelectorAll('.settings-page button')].find((button) => button.textContent?.includes('粘贴 JSON')))?.click()`
    )
    const oauthImportDialog = await waitFor<{
      top: number
      bottom: number
      textareaName: string
      textareaBottom: number
      actionBottom: number
      missingDescriptionTargets: string[]
    }>(
      `(() => {
      const dialog = document.querySelector('[role="dialog"]')
      const textarea = dialog?.querySelector('textarea')
      const actions = [...(dialog?.querySelectorAll('button') ?? [])]
      const action = actions.find((button) => button.textContent?.trim() === '导入')
      const missingDescriptionTargets = [...(dialog?.querySelectorAll('[aria-labelledby], [aria-describedby]') ?? [])]
        .flatMap((element) => ['aria-labelledby', 'aria-describedby'].flatMap((attribute) =>
          (element.getAttribute(attribute) ?? '').split(/\\s+/).filter((id) => id && !document.getElementById(id))
            .map((id) => element.tagName + '[' + attribute + '=' + id + ']')
        ))
      return {
        top: dialog?.getBoundingClientRect().top ?? -1,
        bottom: dialog?.getBoundingClientRect().bottom ?? innerHeight + 1,
        textareaName: textarea?.getAttribute('aria-label') ?? textarea?.labels?.[0]?.textContent?.trim() ?? '',
        textareaBottom: textarea?.getBoundingClientRect().bottom ?? innerHeight + 1,
        actionBottom: action?.getBoundingClientRect().bottom ?? innerHeight + 1,
        missingDescriptionTargets
      }
    })()`,
      (dialog) => Boolean(dialog && dialog.top >= 0),
      'the OAuth account import dialog'
    )
    await new Promise((resolveWait) => setTimeout(resolveWait, 300))
    expect(oauthImportDialog.top).toBeGreaterThanOrEqual(0)
    expect(oauthImportDialog.bottom).toBeLessThanOrEqual(Math.round(560 / 1.5) + 1)
    expect(oauthImportDialog.textareaName).not.toBe('')
    expect(oauthImportDialog.textareaBottom).toBeLessThanOrEqual(oauthImportDialog.bottom + 1)
    expect(oauthImportDialog.actionBottom).toBeLessThanOrEqual(oauthImportDialog.bottom + 1)
    expect(oauthImportDialog.missingDescriptionTargets).toEqual([])
    if (screenshotDir) await captureScreenshot(join(screenshotDir, '24-oauth-import-dialog.png'))
    await call('Emulation.setDeviceMetricsOverride', {
      width: Math.round(760 / 1.5),
      height: 300,
      deviceScaleFactor: 1.5,
      mobile: false
    })
    await new Promise((resolveWait) => setTimeout(resolveWait, 300))
    const shortImportDialog = await evaluate<{
      top: number
      bottom: number
      actionTop: number
      actionBottom: number
      scrollHeight: number
      clientHeight: number
    }>(`(async () => {
      const dialog = document.querySelector('[role="dialog"]')
      const action = [...(dialog?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.trim() === '导入')
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame))
      return {
        top: dialog?.getBoundingClientRect().top ?? -1,
        bottom: dialog?.getBoundingClientRect().bottom ?? innerHeight + 1,
        actionTop: action?.getBoundingClientRect().top ?? -1,
        actionBottom: action?.getBoundingClientRect().bottom ?? innerHeight + 1,
        scrollHeight: dialog?.scrollHeight ?? 0,
        clientHeight: dialog?.clientHeight ?? 0
      }
    })()`)
    if (!shortImportDialog) throw new Error('OAuth import dialog metrics were unavailable')
    if (screenshotDir) await captureScreenshot(join(screenshotDir, '25-oauth-import-short.png'))
    expect(shortImportDialog.top, JSON.stringify(shortImportDialog)).toBeGreaterThanOrEqual(0)
    expect(shortImportDialog.bottom).toBeLessThanOrEqual(301)
    expect(shortImportDialog.actionTop).toBeGreaterThanOrEqual(shortImportDialog.top - 1)
    expect(shortImportDialog.actionBottom, JSON.stringify(shortImportDialog)).toBeLessThanOrEqual(
      shortImportDialog.bottom + 1
    )
    expect(shortImportDialog.scrollHeight).toBeLessThanOrEqual(shortImportDialog.clientHeight + 1)
    await call('Emulation.setDeviceMetricsOverride', {
      width: Math.round(760 / 1.5),
      height: Math.round(560 / 1.5),
      deviceScaleFactor: 1.5,
      mobile: false
    })
    const importedEmail = 'ola-e2e-oauth@example.invalid'
    const fakeOauthJson = JSON.stringify([
      {
        email: importedEmail,
        access_token: 'ola-e2e-placeholder-token',
        expires_at: Date.now() + 86_400_000
      }
    ])
    await evaluate(`(() => {
      const textarea = document.querySelector('[role="dialog"] textarea')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(textarea, ${JSON.stringify(fakeOauthJson)})
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await evaluate(
      `([...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent?.trim() === '导入'))?.click()`
    )
    await waitFor<boolean>(
      `!document.querySelector('[role="dialog"]') && document.body.innerText.includes(${JSON.stringify(importedEmail)}) && document.body.innerText.includes('成功导入 1 条，跳过 0 条')`,
      Boolean,
      'the imported OAuth account and numeric success result'
    )
    let savedProviderConfig = ''
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        savedProviderConfig = await readFile(join(root, 'config.json'), 'utf8')
      } catch {
        // The first provider write may still be pending.
      }
      if (savedProviderConfig.includes(importedEmail)) break
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    expect(savedProviderConfig).toContain(importedEmail)
    expect(savedProviderConfig).not.toContain('ola-e2e-placeholder-token')
    expect((await stat(join(root, 'providers', 'secrets.bin'))).size).toBeGreaterThan(0)
    const localState = JSON.parse(
      await readFile(join(root, 'electron-user-data', 'session-data', 'Local State'), 'utf8')
    ) as { os_crypt?: { encrypted_key?: unknown } }
    expect(typeof localState.os_crypt?.encrypted_key).toBe('string')
    const vaultDigestBeforeRestart = createHash('sha256')
      .update(await readFile(join(root, 'providers', 'secrets.bin')))
      .digest('hex')
    const vaultHeader = (await readFile(join(root, 'providers', 'secrets.bin')))
      .subarray(0, 16)
      .toString('hex')
    if (process.env.OLA_E2E_FORCE_KILL_AFTER_IMPORT === '1') {
      await stopApp(false)
      expect(forcedStopCount).toBe(1)
      await startApp()
      const state = await evaluate<unknown>(
        `window.ola.ipc.invokeMessagePack('config:get', 'ola-providers').then((bucket) => Boolean(bucket?.state?.providers?.some((provider) => provider.name === 'Codex (OAuth)' && provider.oauthAccounts?.[0]?.oauth?.accessToken))).catch((error) => error.message)`
      )
      expect(state).toBe(true)
      return
    }
    const localStateBeforeRestart = (
      await stat(join(root, 'electron-user-data', 'session-data', 'Local State'))
    ).size
    await evaluate(`(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => { throw new Error('OLA_E2E_CLIPBOARD_DENIED') } }
      })
      const exportButton = [...document.querySelectorAll('.settings-page button')]
        .find((button) => button.textContent?.trim() === '导出')
      exportButton?.click()
      return Boolean(exportButton)
    })()`)
    await waitFor<boolean>(
      `document.body.innerText.includes('导出失败：OLA_E2E_CLIPBOARD_DENIED')`,
      Boolean,
      'the OAuth export failure message'
    )
    expect(
      await evaluate<boolean>(`document.body.innerText.includes('ola-e2e-placeholder-token')`)
    ).toBe(false)
    await evaluate(`document.querySelector('.settings-page nav button[title="系统设置"]')?.click()`)
    const systemForm = await waitFor<{
      endpointLabel: string
      environmentLabel: string
      proxyLabel: string
      endpointDescription: string | null
      proxyDescription: string | null
      platformBadge: string
    }>(
      `(() => {
        const endpoint = document.getElementById('settings-shell-endpoint')
        const environment = document.getElementById('settings-shell-environment')
        const proxy = document.getElementById('settings-system-proxy')
        return {
          endpointLabel: endpoint?.labels?.[0]?.textContent?.trim() ?? '',
          environmentLabel: environment?.labels?.[0]?.textContent?.trim() ?? '',
          proxyLabel: proxy?.labels?.[0]?.textContent?.trim() ?? '',
          endpointDescription: endpoint?.getAttribute('aria-describedby') ?? null,
          proxyDescription: proxy?.getAttribute('aria-describedby') ?? null,
          platformBadge: document.querySelector('.settings-page [data-slot="badge"]')?.textContent?.trim() ?? ''
        }
      })()`,
      (form) => form?.endpointLabel === 'Shell 执行端',
      'the system settings form labels'
    )
    expect(systemForm.environmentLabel).toBe('Shell 环境变量')
    expect(systemForm.proxyLabel).toBe('系统代理')
    expect(systemForm.endpointDescription).toBe('settings-shell-endpoint-description')
    expect(systemForm.proxyDescription).toBe('settings-system-proxy-description')
    expect(systemForm.platformBadge).toContain('Windows')
    await evaluate(`(() => {
      const textarea = document.getElementById('settings-shell-environment')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(textarea, 'INVALID')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await waitFor<boolean>(
      `(() => {
        const textarea = document.getElementById('settings-shell-environment')
        const error = document.getElementById('settings-shell-environment-error')
        return textarea?.getAttribute('aria-invalid') === 'true' &&
          textarea?.getAttribute('aria-describedby')?.includes('settings-shell-environment-error') &&
          Boolean(error?.textContent?.trim())
      })()`,
      Boolean,
      'the system shell environment validation announcement'
    )
    await call('Emulation.setDeviceMetricsOverride', {
      width: 1100,
      height: 700,
      deviceScaleFactor: 1,
      mobile: false
    })
    await evaluate(`document.querySelector('.settings-page nav button[title="频道"]')?.click()`)
    await waitFor<boolean>(
      `Boolean(document.querySelector('.channel-settings-list')?.getClientRects().length && document.querySelector('.channel-settings-detail')?.getClientRects().length && !document.querySelector('.channel-settings-mobile-switch')?.getClientRects().length)`,
      Boolean,
      'both channel panes at wide width'
    )
    await call('Emulation.setDeviceMetricsOverride', {
      width: Math.round(760 / 1.5),
      height: Math.round(560 / 1.5),
      deviceScaleFactor: 1.5,
      mobile: false
    })
    await evaluate(`document.querySelector('.settings-page nav button[title="插件"]')?.click()`)
    await waitFor<boolean>(
      `document.querySelector('.settings-page nav button[title="插件"]')?.getAttribute('aria-current') === 'page'`,
      Boolean,
      'plugin settings before keyboard navigation'
    )
    const pluginTabSemantics = await evaluate<{
      tabCount: number
      tabbableCount: number
      selectedTabId: string | null
      panelLabelledBy: string | null
      controlsPanel: boolean
    }>(`(() => {
      const tabs = [...document.querySelectorAll('.app-plugin-tab-list [role="tab"]')]
      const selectedTab = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')
      const panel = document.getElementById('app-plugin-panel-content')
      return {
        tabCount: tabs.length,
        tabbableCount: tabs.filter((tab) => tab.tabIndex === 0).length,
        selectedTabId: selectedTab?.id ?? null,
        panelLabelledBy: panel?.getAttribute('aria-labelledby') ?? null,
        controlsPanel: tabs.every((tab) => tab.getAttribute('aria-controls') === panel?.id)
      }
    })()`)
    if (!pluginTabSemantics) throw new Error('Plugin tab semantics were unavailable')
    expect(pluginTabSemantics.tabCount).toBeGreaterThanOrEqual(4)
    expect(pluginTabSemantics.tabbableCount).toBe(1)
    expect(pluginTabSemantics.selectedTabId).toBe('app-plugin-tab-image')
    expect(pluginTabSemantics.panelLabelledBy).toBe(pluginTabSemantics.selectedTabId)
    expect(pluginTabSemantics.controlsPanel).toBe(true)
    await evaluate(`document.getElementById('app-plugin-tab-image')?.focus()`)
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'ArrowRight',
      code: 'ArrowRight',
      windowsVirtualKeyCode: 39
    })
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'ArrowRight',
      code: 'ArrowRight',
      windowsVirtualKeyCode: 39
    })
    await waitFor<boolean>(
      `(() => {
        const tabs = [...document.querySelectorAll('.app-plugin-tab-list [role="tab"]')]
        return tabs[1]?.getAttribute('aria-selected') === 'true' &&
          document.activeElement === tabs[1] &&
          document.getElementById('app-plugin-panel-content')?.getAttribute('aria-labelledby') === tabs[1].id
      })()`,
      Boolean,
      'keyboard navigation between built-in plugin tabs'
    )
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Home',
      code: 'Home',
      windowsVirtualKeyCode: 36
    })
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Home',
      code: 'Home',
      windowsVirtualKeyCode: 36
    })
    await waitFor<boolean>(
      `document.getElementById('app-plugin-tab-image')?.getAttribute('aria-selected') === 'true' && document.activeElement?.id === 'app-plugin-tab-image'`,
      Boolean,
      'Home returning to the first built-in plugin tab'
    )
    const compactCapabilityLayout = await evaluate<{
      toggleVisible: boolean
      overviewVisible: boolean
      panelHeight: number
      pluginOverflowY: string
    }>(`(() => {
      const toggle = document.getElementById('capability-center-overview-toggle')
      const overview = document.getElementById('capability-center-overview')
      const panel = document.getElementById('capability-panel-builtin')
      return {
        toggleVisible: Boolean(toggle?.getClientRects().length),
        overviewVisible: Boolean(overview?.getClientRects().length),
        panelHeight: panel?.getBoundingClientRect().height ?? 0,
        pluginOverflowY: getComputedStyle(document.querySelector('.app-plugin-content')).overflowY
      }
    })()`)
    if (!compactCapabilityLayout) throw new Error('Capability layout metrics were unavailable')
    expect(compactCapabilityLayout.toggleVisible).toBe(true)
    expect(compactCapabilityLayout.overviewVisible).toBe(false)
    expect(compactCapabilityLayout.panelHeight).toBeGreaterThan(200)
    expect(compactCapabilityLayout.pluginOverflowY).toBe('visible')
    await evaluate(`document.getElementById('capability-center-overview-toggle')?.click()`)
    await waitFor<boolean>(
      `document.getElementById('capability-center-overview-toggle')?.getAttribute('aria-expanded') === 'true' && Boolean(document.getElementById('capability-center-overview')?.getClientRects().length)`,
      Boolean,
      'expanded capability overview in the short window'
    )
    await evaluate(`document.getElementById('capability-center-overview-toggle')?.click()`)
    await waitFor<boolean>(
      `document.getElementById('capability-center-overview-toggle')?.getAttribute('aria-expanded') === 'false' && !document.getElementById('capability-center-overview')?.getClientRects().length`,
      Boolean,
      'collapsed capability overview in the short window'
    )
    const pluginModelSource = await evaluate<{
      width: number
      available: number
      switchName: string | null
    }>(`(() => {
      const trigger = document.querySelector('[aria-label="图片模型来源"]')
      const section = trigger?.closest('section')
      const sectionStyle = section ? getComputedStyle(section) : null
      return {
        width: trigger?.getBoundingClientRect().width ?? 0,
        available: section ? section.clientWidth - parseFloat(sectionStyle.paddingLeft) - parseFloat(sectionStyle.paddingRight) : 0,
        switchName: section?.previousElementSibling?.querySelector('[role="switch"]')?.getAttribute('aria-label') ?? null
      }
    })()`)
    if (!pluginModelSource) throw new Error('Plugin model source metrics were unavailable')
    expect(pluginModelSource.width).toBeGreaterThan(0)
    expect(pluginModelSource.width).toBeLessThanOrEqual(pluginModelSource.available + 1)
    expect(pluginModelSource.switchName).toBe('启用插件')
    await evaluate(`document.querySelector('[aria-label="图片模型来源"]')?.click()`)
    await waitFor<boolean>(
      `Boolean([...document.querySelectorAll('[role="option"]')].find((item) => item.textContent?.includes('为插件单独指定模型')))`,
      Boolean,
      'plugin model source options'
    )
    await evaluate(
      `([...document.querySelectorAll('[role="option"]')].find((item) => item.textContent?.includes('为插件单独指定模型')))?.click()`
    )
    await waitFor<boolean>(
      `Boolean(document.querySelector('[aria-label="服务商"]') && document.querySelector('[aria-label="图片模型"]'))`,
      Boolean,
      'plugin override model fields'
    )
    const pluginOverrideWidths = await evaluate<
      Array<{ name: string; width: number; available: number }>
    >(`(() =>
      ['服务商', '图片模型'].map((name) => {
        const trigger = document.querySelector('[aria-label="' + name + '"]')
        const parent = trigger?.parentElement
        return { name, width: trigger?.getBoundingClientRect().width ?? 0, available: parent?.clientWidth ?? 0 }
      })
    )()`)
    if (!pluginOverrideWidths) throw new Error('Plugin override widths were unavailable')
    for (const field of pluginOverrideWidths) {
      expect(field.width, field.name).toBeGreaterThan(0)
      expect(field.width, field.name).toBeLessThanOrEqual(field.available + 1)
    }
    if (screenshotDir) {
      await evaluate(
        `document.querySelector('[aria-label="服务商"]')?.scrollIntoView({ block: 'center' })`
      )
      await captureScreenshot(join(screenshotDir, '23-plugin-model-override.png'))
    }
    await call('Emulation.setDeviceMetricsOverride', {
      width: 1100,
      height: 700,
      deviceScaleFactor: 1,
      mobile: false
    })
    const wideCapabilityLayout = await evaluate<{
      toggleVisible: boolean
      overviewVisible: boolean
      pluginOverflowY: string
    }>(`(() => ({
      toggleVisible: Boolean(document.getElementById('capability-center-overview-toggle')?.getClientRects().length),
      overviewVisible: Boolean(document.getElementById('capability-center-overview')?.getClientRects().length),
      pluginOverflowY: getComputedStyle(document.querySelector('.app-plugin-content')).overflowY
    }))()`)
    expect(wideCapabilityLayout).toEqual({
      toggleVisible: false,
      overviewVisible: true,
      pluginOverflowY: 'auto'
    })
    await call('Emulation.setDeviceMetricsOverride', {
      width: Math.round(760 / 1.5),
      height: Math.round(560 / 1.5),
      deviceScaleFactor: 1.5,
      mobile: false
    })
    const builtInTabFocused = await evaluate<boolean>(`(() => {
      const tab = document.getElementById('capability-tab-builtin')
      tab?.focus()
      return document.activeElement === tab && tab?.getAttribute('aria-selected') === 'true'
    })()`)
    expect(builtInTabFocused).toBe(true)
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'ArrowRight',
      code: 'ArrowRight',
      windowsVirtualKeyCode: 39
    })
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'ArrowRight',
      code: 'ArrowRight',
      windowsVirtualKeyCode: 39
    })
    await waitFor<boolean>(
      `document.getElementById('capability-tab-custom')?.getAttribute('aria-selected') === 'true' && document.activeElement?.id === 'capability-tab-custom' && document.querySelector('.settings-page')?.innerText.includes('自定义扩展')`,
      Boolean,
      'keyboard navigation to custom extensions'
    )
    await evaluate(`document.querySelector('.settings-page nav button[title="通用设置"]')?.click()`)
    await waitFor<boolean>(
      `Boolean(document.querySelector('.settings-page input[type="number"].max-w-32'))`,
      Boolean,
      'general settings after the responsive page sweep'
    )
    await call('Emulation.clearDeviceMetricsOverride')

    await rename(settingsPath, backupPath)
    await mkdir(settingsPath)
    await evaluate(
      `(() => { const input = document.querySelector('.settings-page input[type="number"].max-w-32'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '17'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); return true })()`
    )
    const enlargedFontMetrics = await waitFor<{ root: number; description: number }>(
      fontMetricsExpression,
      (metrics) => metrics?.root === 17 && metrics.description > initialFontMetrics.description,
      'the settings description to scale with the selected font size'
    )
    expect(enlargedFontMetrics.description).toBeCloseTo((13 * 17) / 16, 2)
    await waitFor<boolean>(
      `Boolean(document.querySelector('.settings-page button[aria-label="重试保存设置"]'))`,
      Boolean,
      'visible save failure and retry control'
    )
    const untouched = JSON.parse(await readFile(backupPath, 'utf8')) as {
      'ola-settings': { state: { fontSize: number } }
    }
    expect(untouched['ola-settings'].state.fontSize).toBe(16)

    await rmdir(settingsPath)
    await rename(backupPath, settingsPath)
    await evaluate(
      `document.querySelector('.settings-page button[aria-label="重试保存设置"]').click()`
    )
    await waitFor<boolean>(
      `document.body.innerText.includes('已保存') && !document.querySelector('.settings-page button[aria-label="重试保存设置"]')`,
      Boolean,
      'saved status after retry'
    )
    const persisted = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      'ola-settings': { state: { fontSize: number } }
    }
    expect(persisted['ola-settings'].state.fontSize).toBe(17)

    await stopApp()
    expect(forcedStopCount).toBe(0)
    await startApp()
    const diskAfterRestart = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      'ola-providers'?: { state?: { providers?: Array<Record<string, unknown>> } }
    }
    const diskOauthProvider = diskAfterRestart['ola-providers']?.state?.providers?.find(
      (item) => item.name === 'Codex (OAuth)'
    )
    const diskOauthAccount = (
      diskOauthProvider?.oauthAccounts as Array<Record<string, unknown>>
    )?.[0]
    const vaultBytesAfterRestart = (await stat(join(root, 'providers', 'secrets.bin'))).size
    const vaultDigestAfterRestart = createHash('sha256')
      .update(await readFile(join(root, 'providers', 'secrets.bin')))
      .digest('hex')
    const restoredOauthState = await evaluate<{
      accounts: number
      tokenRestored: boolean
      activeTokenRestored: boolean
    }>(`(async () => {
      const bucket = await window.ola.ipc.invokeMessagePack('config:get', 'ola-providers')
      const providers = bucket?.state?.providers ?? []
      const provider = providers.find((item) => item.id === 'codex-oauth') ??
        providers.find((item) => item.name === 'Codex (OAuth)')
      return {
        accounts: provider?.oauthAccounts?.length ?? 0,
        tokenRestored: Boolean(provider?.oauthAccounts?.[0]?.oauth?.accessToken),
        activeTokenRestored: Boolean(provider?.oauth?.accessToken)
      }
    })()`)
    expect(
      restoredOauthState?.accounts,
      JSON.stringify({
        restoredOauthState,
        diskMarker: diskOauthAccount?.oauthStored,
        vaultBytesAfterRestart,
        vaultChangedAfterRestart: vaultDigestAfterRestart !== vaultDigestBeforeRestart,
        vaultHeader,
        localStateBeforeRestart,
        logs: logs.slice(-2500)
      })
    ).toBe(1)
    expect(
      restoredOauthState?.tokenRestored,
      JSON.stringify({
        restoredOauthState,
        diskMarker: diskOauthAccount?.oauthStored,
        topMarker: diskOauthProvider?.oauthStored,
        vaultBytesAfterRestart,
        vaultChangedAfterRestart: vaultDigestAfterRestart !== vaultDigestBeforeRestart
      })
    ).toBe(true)
    expect(restoredOauthState?.activeTokenRestored, JSON.stringify(restoredOauthState)).toBe(true)
    await waitFor<boolean>(
      `Boolean([...document.querySelectorAll('button')].find((button) => button.innerText.includes('未配置 API Key')))`,
      Boolean,
      'settings entry after restart'
    )
    await evaluate(
      `[...document.querySelectorAll('button')].find((button) => button.innerText.includes('未配置 API Key')).click()`
    )
    await waitFor<boolean>(
      `Boolean(document.querySelector('.settings-page'))`,
      Boolean,
      'settings after restart'
    )
    await evaluate(`document.querySelector('.settings-page button[title="通用设置"]').click()`)
    const reloaded = await waitFor<string>(
      `document.querySelector('.settings-page input[type="number"].max-w-32')?.value ?? ''`,
      (value) => value === '17',
      'the persisted font size after restart'
    )
    expect(reloaded).toBe('17')
    const reloadedFontMetrics = await waitFor<{ root: number; description: number }>(
      fontMetricsExpression,
      (metrics) => metrics?.root === 17 && metrics.description > initialFontMetrics.description,
      'the persisted settings description font size after restart'
    )
    expect(reloadedFontMetrics.description).toBeCloseTo(enlargedFontMetrics.description, 2)
    await evaluate(
      `document.querySelector('.settings-page nav button[title="AI 服务商"]')?.click()`
    )
    await waitFor<boolean>(
      `Boolean([...document.querySelectorAll('.provider-settings-list button')].find((button) => button.textContent?.includes('Codex (OAuth)')))`,
      Boolean,
      'the OAuth provider after restart'
    )
    await evaluate(
      `([...document.querySelectorAll('.provider-settings-list button')].find((button) => button.textContent?.includes('Codex (OAuth)')))?.click()`
    )
    await waitFor<boolean>(
      `document.body.innerText.includes(${JSON.stringify(importedEmail)})`,
      Boolean,
      'the imported OAuth account after restart'
    )
    const publicConfigBeforeVaultFailure = await readFile(join(root, 'config.json'), 'utf8')
    await stopApp()
    await writeFile(join(root, 'providers', 'secrets.bin'), 'invalid-encrypted-test-data')
    await startApp()
    await waitFor<boolean>(
      `Boolean([...document.querySelectorAll('button')].find((button) => button.innerText.includes('未配置 API Key')))`,
      Boolean,
      'the settings entry after an unreadable credential vault'
    )
    await evaluate(
      `[...document.querySelectorAll('button')].find((button) => button.innerText.includes('未配置 API Key')).click()`
    )
    await waitFor<boolean>(
      `Boolean(document.querySelector('.settings-page'))`,
      Boolean,
      'settings with an unreadable credential vault'
    )
    await evaluate(
      `document.querySelector('.settings-page nav button[title="AI 服务商"]')?.click()`
    )
    const vaultWarningState = await evaluate<{
      unavailable: boolean
      panel: boolean
      alerts: string[]
    }>(`(async () => {
      const snapshot = await window.ola.ipc.invokeMessagePack('provider:mirror-snapshot')
      return {
        unavailable: Boolean(snapshot?.credentialVaultUnavailable),
        panel: Boolean(document.querySelector('.provider-settings-container')),
        alerts: [...document.querySelectorAll('[role="alert"]')]
          .map((item) => item.textContent?.trim() ?? '')
      }
    })()`)
    const rawConfigAfterVaultFailure = JSON.parse(
      await readFile(join(root, 'config.json'), 'utf8')
    ) as Record<string, unknown>
    const bucketSummary = (config: Record<string, unknown>) => {
      const bucket = config['ola-providers'] as
        | { state?: { providers?: Array<Record<string, unknown>> } }
        | undefined
      return bucket?.state?.providers?.map((provider) => ({
        id: provider.id,
        apiKeyStored: provider.apiKeyStored,
        oauthStored: provider.oauthStored,
        accountCount: Array.isArray(provider.oauthAccounts) ? provider.oauthAccounts.length : 0,
        accountStored: Array.isArray(provider.oauthAccounts)
          ? provider.oauthAccounts.map((account: { oauthStored?: boolean }) => account.oauthStored)
          : []
      }))
    }
    expect(
      vaultWarningState?.unavailable,
      JSON.stringify({
        ...vaultWarningState,
        hasProviderBucket: rawConfigAfterVaultFailure['ola-providers'] !== undefined,
        configChanged:
          JSON.stringify(rawConfigAfterVaultFailure) !==
          JSON.stringify(JSON.parse(publicConfigBeforeVaultFailure)),
        before: bucketSummary(JSON.parse(publicConfigBeforeVaultFailure)),
        after: bucketSummary(rawConfigAfterVaultFailure),
        vaultSize: (await stat(join(root, 'providers', 'secrets.bin'))).size
      })
    ).toBe(true)
    await waitFor<boolean>(
      `Boolean([...document.querySelectorAll('[role="alert"]')].find((item) => item.textContent?.includes('服务商凭据暂时无法读取')))`,
      Boolean,
      'the provider credential vault warning'
    )
    expect(
      await evaluate<boolean>(
        `document.querySelector('.provider-settings-panels')?.hasAttribute('inert') ?? false`
      )
    ).toBe(true)
    expect(await readFile(join(root, 'config.json'), 'utf8')).toBe(publicConfigBeforeVaultFailure)
  }, 90_000)
})
