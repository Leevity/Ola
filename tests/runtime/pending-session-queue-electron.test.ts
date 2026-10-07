import { EventEmitter, once } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'
import { RunJournal } from '../../src/runtime/storage/run-journal'

const require = createRequire(import.meta.url)
type DevToolsWebSocket = EventEmitter & {
  readyState: number
  close(): void
  send(data: string): void
}
const WebSocket = require('ws') as { new (url: string): DevToolsWebSocket; OPEN: number }
const electronBinary = require('electron') as string
const RUN_ELECTRON_E2E = process.env.RUN_PENDING_QUEUE_ELECTRON_E2E === '1'
const packagedExe = process.env.OLA_PACKAGED_EXE

type DevToolsTarget = { type: string; webSocketDebuggerUrl?: string }
let root: string | undefined
let repository: BusinessRepository | undefined
let child: ChildProcess | undefined
let socket: DevToolsWebSocket | undefined
let mainSocket: DevToolsWebSocket | undefined
let secondarySocket: DevToolsWebSocket | undefined
let childLogs = ''
const testTerminalIds: string[] = []
let accountFixtureServer: Server | undefined

async function waitForPage(port: number): Promise<DevToolsTarget> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      if (response.ok) {
        const targets = (await response.json()) as DevToolsTarget[]
        const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
        if (page) return page
      }
    } catch {
      // Electron is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('Timed out waiting for the Electron renderer')
}

async function waitForMainInspector(port: number): Promise<DevToolsTarget> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      if (response.ok) {
        const targets = (await response.json()) as DevToolsTarget[]
        const target = targets.find((item) => item.type === 'node' && item.webSocketDebuggerUrl)
        if (target) return target
      }
    } catch {
      // Electron Main has not opened its isolated test inspector yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Timed out waiting for the Electron Main inspector')
}

async function waitForPageMatching(
  port: number,
  predicate: (target: DevToolsTarget & { url?: string }) => boolean,
  description: string
): Promise<DevToolsTarget & { url?: string }> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      if (response.ok) {
        const targets = (await response.json()) as Array<DevToolsTarget & { url?: string }>
        const page = targets.find((target) => target.type === 'page' && predicate(target))
        if (page?.webSocketDebuggerUrl) return page
      }
    } catch {
      // Electron is still creating the detached window.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${description}. Electron logs: ${childLogs.slice(-8000)}`)
}

function devToolsCall(
  ws: DevToolsWebSocket,
  method: string,
  params: Record<string, unknown> = {}
): Promise<{ result?: { value?: unknown } }> {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1_000_000_000)
    const onMessage = (raw: Buffer | string): void => {
      const message = JSON.parse(raw.toString()) as {
        id?: number
        error?: { message: string }
        result?: { result?: { value?: unknown } }
      }
      if (message.id !== id) return
      ws.off('message', onMessage)
      if (message.error) reject(new Error(`${method}: ${message.error.message}`))
      else resolve(message.result ?? {})
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function waitForPageText(
  ws: DevToolsWebSocket,
  predicate: (value: string) => boolean,
  description: string
): Promise<string> {
  let lastText = ''
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await devToolsCall(ws, 'Runtime.evaluate', {
      expression: 'document.body?.innerText ?? ""',
      returnByValue: true
    })
    lastText = String(result.result?.value ?? '')
    if (predicate(lastText)) return lastText
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const diagnostics = await devToolsCall(ws, 'Runtime.evaluate', {
    expression: `({url:location.href,title:document.title,readyState:document.readyState,root:document.querySelector('#root')?.innerHTML.slice(0,500)})`,
    returnByValue: true
  })
  throw new Error(
    `Timed out waiting for ${description}. Renderer text: ${lastText.slice(0, 1200)}. Page: ${JSON.stringify(diagnostics.result?.value)}. Electron logs: ${childLogs.slice(-8000)}`
  )
}

async function waitForExpression<T>(
  ws: DevToolsWebSocket,
  expression: string,
  predicate: (value: T | undefined) => boolean,
  description: string
): Promise<T> {
  let value: T | undefined
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await devToolsCall(ws, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    value = result.result?.value as T | undefined
    if (predicate(value)) return value as T
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const page = await devToolsCall(ws, 'Runtime.evaluate', {
    expression: `({hash:location.hash, body:document.body.innerText.slice(-1200)})`,
    returnByValue: true
  })
  throw new Error(
    `Timed out waiting for ${description}: ${JSON.stringify(value)}. Page: ${JSON.stringify(page.result?.value)}. Electron logs: ${childLogs.slice(-6000)}`
  )
}

async function captureScreenshot(ws: DevToolsWebSocket, name: string): Promise<void> {
  const directory = process.env.OLA_E2E_SCREENSHOT_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  const result = await devToolsCall(ws, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false
  })
  const data = (result as { data?: string }).data
  if (!data) throw new Error(`Screenshot capture returned no image data for ${name}`)
  await writeFile(join(directory, name), Buffer.from(data, 'base64'))
}

afterEach(async () => {
  secondarySocket?.close()
  secondarySocket = undefined
  mainSocket?.close()
  mainSocket = undefined
  if (socket?.readyState === WebSocket.OPEN) {
    for (const terminalId of testTerminalIds) {
      try {
        await devToolsCall(socket, 'Runtime.evaluate', {
          expression: `window.ola.ipc.invokeMessagePack('terminal:kill', { id: ${JSON.stringify(terminalId)} })`,
          awaitPromise: true,
          returnByValue: true
        })
      } catch {
        // Electron may have exited before the test PTY cleanup runs.
      }
    }
  }
  testTerminalIds.length = 0
  socket?.close()
  socket = undefined
  if (child && !child.killed) {
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))])
  }
  child = undefined
  childLogs = ''
  if (accountFixtureServer) {
    await new Promise<void>((resolve, reject) => {
      accountFixtureServer!.close((error) => (error ? reject(error) : resolve()))
    })
    accountFixtureServer = undefined
  }
  await repository?.close()
  repository = undefined
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  root = undefined
})

describe.skipIf(!RUN_ELECTRON_E2E)('pending session queue Electron recovery', () => {
  it('restores an interrupted send as reviewable and leaves it paused after app restart', async () => {
    root = await mkdtemp(join(tmpdir(), 'ola-pending-session-queue-electron-'))
    await writeFile(join(root, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n', 'utf8')
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        'ola-settings': {
          state: { onboardingCompleted: true, onboardingCompletedAt: Date.now() },
          version: 29
        },
        'ola-extension-activation': {
          state: {
            activeExtensionIdsByProject: {
              __global__: ['e2e-view'],
              'project-terminal-second-e2e': ['e2e-view']
            }
          },
          version: 1
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
                baseUrl: 'http://127.0.0.1:1/v1',
                enabled: true,
                requiresApiKey: false,
                createdAt: Date.now(),
                models: [{ id: 'e2e-model', name: 'E2E Model', enabled: true, category: 'chat' }]
              }
            ],
            activeProviderId: 'e2e-provider',
            activeModelId: 'e2e-model'
          },
          version: 0
        }
      }),
      'utf8'
    )
    const extensionDirectory = join(root, 'extensions', 'e2e-view')
    await mkdir(join(extensionDirectory, 'views'), { recursive: true })
    await writeFile(
      join(extensionDirectory, 'extension.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'e2e-view',
        name: 'E2E View',
        version: '1.0.0',
        tools: [
          {
            name: 'fixture',
            description: 'Read the isolated fixture endpoint.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            kind: 'http',
            http: { method: 'GET', url: 'https://example.invalid' }
          }
        ],
        views: [
          { name: 'diagnostics', title: 'E2E Diagnostics View', entry: 'views/view.html' },
          {
            name: 'broken-diagnostics',
            title: 'E2E Broken Diagnostics View',
            entry: 'views/missing.html'
          }
        ],
        commands: [
          { name: 'open-diagnostics', title: 'E2E Diagnostics View', view: 'diagnostics' },
          {
            name: 'open-broken-diagnostics',
            title: 'E2E Broken Diagnostics View',
            view: 'broken-diagnostics'
          }
        ]
      }),
      'utf8'
    )
    await writeFile(
      join(extensionDirectory, 'views', 'view.html'),
      '<script>parent.document.documentElement.dataset.e2eExtensionPwned="yes"</script><h1>Safe extension view</h1>',
      'utf8'
    )
    await writeFile(
      join(root, 'extensions.json'),
      JSON.stringify({
        'e2e-view': { enabled: true, installedAt: Date.now(), updatedAt: Date.now(), config: {} }
      }),
      'utf8'
    )
    repository = new BusinessRepository({ path: join(root, 'data.db'), mode: 'direct' })
    const now = Date.now()
    const projectRoot = join(root, 'sample-project')
    await mkdir(projectRoot, { recursive: true })
    const secondProjectRoot = join(root, 'second-project')
    await mkdir(secondProjectRoot, { recursive: true })
    await repository.createProject({
      id: 'project-terminal-e2e',
      name: 'Terminal E2E Project',
      workspaceId: 'local-personal',
      createdAt: now,
      updatedAt: now,
      workingFolder: projectRoot
    })
    await repository.createProject({
      id: 'project-terminal-second-e2e',
      name: 'Second Terminal E2E Project',
      workspaceId: 'local-personal',
      createdAt: now + 1,
      updatedAt: now + 1,
      workingFolder: secondProjectRoot
    })
    await repository.createSession({
      id: 'session-queue-e2e',
      title: 'Queue recovery e2e session',
      mode: 'chat',
      createdAt: now,
      updatedAt: now,
      workspaceId: 'local-personal'
    })
    await repository.createSession({
      id: 'session-terminal-e2e',
      title: 'Terminal dock e2e session',
      mode: 'code',
      createdAt: now + 1,
      updatedAt: now + 1,
      workspaceId: 'local-personal',
      projectId: 'project-terminal-e2e',
      workingFolder: projectRoot
    })
    await repository.createSession({
      id: 'session-terminal-second-e2e',
      title: 'Second terminal dock e2e session',
      mode: 'code',
      createdAt: now + 2,
      updatedAt: now + 2,
      workspaceId: 'local-personal',
      projectId: 'project-terminal-second-e2e',
      workingFolder: secondProjectRoot
    })
    await repository.createSession({
      id: 'session-queue-secondary-e2e',
      title: 'Secondary window queue e2e session',
      mode: 'chat',
      createdAt: now + 3,
      updatedAt: now + 3,
      workspaceId: 'local-personal'
    })
    await repository.createSession({
      id: 'session-remote-workspace-e2e',
      title: 'Remote workspace only session',
      mode: 'chat',
      createdAt: now + 2,
      updatedAt: now + 2,
      workspaceId: 'e2e-team'
    })
    await repository.createSession({
      id: 'session-delete-failure-e2e',
      title: 'Delete failure recovery session',
      mode: 'chat',
      createdAt: now + 4,
      updatedAt: now + 4,
      workspaceId: 'local-personal'
    })
    await repository.createTask({
      id: 'business-task-e2e',
      sessionId: 'session-queue-e2e',
      workspaceId: 'local-personal',
      subject: 'Linked run entry E2E task',
      description: 'Verify the task board run entry.',
      sortOrder: 0,
      createdAt: now + 4,
      updatedAt: now + 4
    })
    await repository.createTask({
      id: 'team-business-task-e2e',
      sessionId: 'session-remote-workspace-e2e',
      workspaceId: 'e2e-team',
      subject: 'Team workspace E2E task',
      description: 'Verify the team board shows only team tasks.',
      sortOrder: 0,
      createdAt: now + 4,
      updatedAt: now + 4
    })
    for (const [index, status] of [
      'in_progress',
      'in_review',
      'blocked',
      'completed',
      'failed',
      'cancelled'
    ].entries()) {
      await repository.createTask({
        id: `business-task-${status}-e2e`,
        sessionId: 'session-queue-e2e',
        workspaceId: 'local-personal',
        subject: `${status} E2E task`,
        description: 'Verify each task status stays visible.',
        status,
        sortOrder: index + 1,
        createdAt: now + 5,
        updatedAt: now + 5
      })
    }
    await repository.replacePendingSessionQueue('session-queue-e2e', 'local-personal', [
      {
        id: 'interrupted-send',
        text: 'Interrupted message for review',
        createdAt: now,
        dispatchMode: 'after_loop',
        recoveryState: 'dispatching'
      },
      {
        id: 'next-queued-message',
        text: 'Second message stays queued',
        createdAt: now + 1,
        dispatchMode: 'after_loop'
      },
      {
        id: 'long-queued-message',
        text: `Long message layout sentinel ${'A'.repeat(4_000)}`,
        createdAt: now + 2,
        dispatchMode: 'after_loop'
      }
    ])
    await repository.replacePendingSessionQueue('session-queue-secondary-e2e', 'local-personal', [
      {
        id: 'secondary-window-queue-sentinel',
        text: 'SECONDARY_WINDOW_QUEUE_SENTINEL',
        createdAt: now + 3,
        dispatchMode: 'after_loop'
      }
    ])
    await repository.createCronJob({
      id: 'cron-delivery-ui-e2e',
      workspaceId: 'local-personal',
      name: 'Cron delivery reconciliation E2E',
      scheduleKind: 'every',
      scheduleEvery: 60_000,
      prompt: 'A completed run with an unknown channel delivery.',
      createdAt: now + 20,
      deliveryMode: 'session',
      pluginId: 'fixture-channel',
      pluginChatId: 'fixture-chat'
    })
    await repository.createCronRun({
      id: 'cron-delivery-run-ui-e2e',
      jobId: 'cron-delivery-ui-e2e',
      workspaceId: 'local-personal',
      startedAt: now + 21,
      jobNameSnapshot: 'Cron delivery reconciliation E2E',
      promptSnapshot: 'A completed run with an unknown channel delivery.'
    })
    await repository.finishCronRun({
      id: 'cron-delivery-run-ui-e2e',
      workspaceId: 'local-personal',
      finishedAt: now + 22,
      status: 'success',
      toolCallCount: 1,
      outputSummary: 'The run completed; verify its channel delivery.'
    })
    await repository.recordCronDelivery({
      id: 'cron-delivery-unknown-ui-e2e',
      runId: 'cron-delivery-run-ui-e2e',
      workspaceId: 'local-personal',
      toolCallId: 'cron-delivery-tool-ui-e2e',
      kind: 'channel',
      status: 'pending',
      startedAt: now + 22,
      pluginId: 'fixture-channel',
      chatId: 'fixture-chat'
    })
    await repository.recordCronDelivery({
      id: 'cron-delivery-unknown-ui-e2e',
      runId: 'cron-delivery-run-ui-e2e',
      workspaceId: 'local-personal',
      toolCallId: 'cron-delivery-tool-ui-e2e',
      kind: 'channel',
      status: 'unknown',
      startedAt: now + 22,
      finishedAt: now + 23,
      errorCode: 'PROCESS_INTERRUPTED',
      pluginId: 'fixture-channel',
      chatId: 'fixture-chat'
    })
    await repository.close()
    repository = undefined
    const deleteFailureDb = new DatabaseSync(join(root, 'data.db'))
    deleteFailureDb.exec(`
      CREATE TRIGGER reject_session_delete
      BEFORE DELETE ON sessions
      BEGIN
        SELECT RAISE(ABORT, 'injected session delete failure');
      END;
    `)
    deleteFailureDb.close()

    const resultPath = join(projectRoot, 'e2e-confirmed-result.md')
    await writeFile(resultPath, '# Confirmed result\n', 'utf8')
    const journalDirectory = join(root, 'electron-user-data', 'ts-runtime', 'runtime-v2')
    await mkdir(journalDirectory, { recursive: true })
    const journal = new RunJournal(join(journalDirectory, 'runs.db'))
    try {
      for (let index = 0; index < 51; index++) {
        const runId = `history-run-${String(index).padStart(3, '0')}`
        await journal.create({
          runId,
          taskId: `history-task-${index}`,
          businessTaskTitle: `History run ${String(index).padStart(3, '0')}`,
          requestId: `history-request-${index}`,
          traceId: `history-trace-${index}`,
          sessionId: 'session-terminal-e2e',
          workspaceId: 'local-personal',
          projectId: 'project-terminal-e2e',
          environmentId: 'local',
          workingDirectory: projectRoot,
          modelSource: { kind: 'local', providerId: 'fixture', modelId: 'fixture' },
          prompt: 'Historical run',
          unattended: false
        })
        await journal.transition(
          runId,
          'local-personal',
          ['queued'],
          index === 0 ? 'failed' : 'completed'
        )
      }
      await journal.create({
        runId: 'artifact-run-e2e',
        taskId: 'runtime-task-e2e',
        requestId: 'artifact-request-e2e',
        traceId: 'artifact-trace-e2e',
        sessionId: 'session-terminal-e2e',
        workspaceId: 'local-personal',
        projectId: 'project-terminal-e2e',
        environmentId: 'local',
        workingDirectory: projectRoot,
        modelSource: { kind: 'local', providerId: 'fixture', modelId: 'fixture' },
        prompt: 'Produce a result',
        unattended: false
      })
      await journal.append('artifact-run-e2e', 'local-personal', 'artifact.registered', {
        toolCallId: 'write-e2e',
        kind: 'file',
        transport: 'local',
        path: resultPath,
        operation: 'create'
      })
      await journal.transition('artifact-run-e2e', 'local-personal', ['queued'], 'completed')
    } finally {
      await journal.close()
    }

    let modelRequestBody = ''
    const modelRequestBodies: string[] = []
    const cookieFixtureRequests: Array<{ path: string; cookie: string }> = []
    accountFixtureServer = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (path === '/v1/chat/completions') {
        let body = ''
        request.setEncoding('utf8')
        request.on('data', (chunk: string) => {
          body += chunk
        })
        request.on('end', () => {
          modelRequestBody = body
          modelRequestBodies.push(body)
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          const currentMessage = (
            JSON.parse(body) as {
              messages?: Array<{ role?: string; content?: unknown }>
            }
          ).messages?.at(-1)
          if (
            currentMessage?.role === 'user' &&
            typeof currentMessage.content === 'string' &&
            currentMessage.content.startsWith('Create the final user-facing outcome')
          ) {
            response.end(
              `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ title: 'E2E task completed', summary: 'The requested task finished.', completedItems: [], artifacts: [], verification: [], warnings: [], nextSteps: [] }) } }] })}\n\ndata: [DONE]\n\n`
            )
            return
          }
          const requestedReport =
            currentMessage?.role === 'user' && typeof currentMessage.content === 'string'
              ? currentMessage.content.includes('E2E_EXTENSION_REPORT_OK')
                ? 'report_ok'
                : currentMessage.content.includes('E2E_EXTENSION_REPORT_FAIL')
                  ? 'report_fail'
                  : null
              : null
          if (requestedReport) {
            response.end(
              `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `e2e-${requestedReport}`, function: { name: `extension__e2e-view__${requestedReport}`, arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`
            )
            return
          }
          response.end(
            'data: {"choices":[{"delta":{"content":"E2E report generated from supplied release notes."}}]}\n\ndata: [DONE]\n\n'
          )
        })
        return
      }
      response.setHeader('content-type', 'application/json')
      if (path === '/api/e2e-browser-cookie-personal') {
        cookieFixtureRequests.push({ path, cookie: request.headers.cookie ?? '' })
        response.setHeader('set-cookie', 'ola-e2e-personal=personal-value; Path=/; HttpOnly')
        response.end(JSON.stringify({ ok: true }))
      } else if (path === '/api/e2e-browser-cookie-team') {
        cookieFixtureRequests.push({ path, cookie: request.headers.cookie ?? '' })
        response.setHeader('set-cookie', 'ola-e2e-team=team-value; Path=/; HttpOnly')
        response.end(JSON.stringify({ ok: true }))
      } else if (path === '/api/e2e-extension/report-ok') {
        response.end(
          JSON.stringify({
            report: { url: 'https://reports.example.test/e2e-ok', name: 'E2E extension report' }
          })
        )
      } else if (path === '/api/e2e-extension/report-fail') {
        response.statusCode = 503
        response.end(
          JSON.stringify({
            report: {
              url: 'https://reports.example.test/e2e-failed',
              name: 'Failed extension report'
            }
          })
        )
      } else if (path === '/api/auth/login') {
        response.end(
          JSON.stringify({
            token: 'e2e-account-token',
            account: { id: 'e2e-account', email: 'e2e@example.test', displayName: 'E2E User' }
          })
        )
      } else if (path === '/api/auth/me') {
        response.end(
          JSON.stringify({
            account: { id: 'e2e-account', email: 'e2e@example.test', displayName: 'E2E User' }
          })
        )
      } else if (path === '/api/account/workspaces') {
        response.end(
          JSON.stringify({
            workspaces: [{ id: 'e2e-team', kind: 'team', name: 'E2E Team', role: 'owner' }]
          })
        )
      } else if (path === '/api/account/workspaces/e2e-team/model-resources') {
        response.end(JSON.stringify({ resources: [] }))
      } else if (path === '/api/devices/register') {
        response.end(
          JSON.stringify({
            device: {
              id: 'e2e-device',
              accountId: 'e2e-account',
              deviceName: 'E2E Desktop',
              platform: 'windows',
              isOnline: true,
              createdAt: new Date().toISOString()
            }
          })
        )
      } else if (path === '/api/devices/e2e-device/signaling-token') {
        response.end(JSON.stringify({ token: 'e2e-signaling-token' }))
      } else if (path === '/api/mesh/v1/nodes/register') {
        response.end(JSON.stringify({ node: { nodeId: 'e2e-node' } }))
      } else if (path === '/api/devices') {
        response.end(JSON.stringify({ devices: [] }))
      } else if (path === '/api/mesh/v1/nodes') {
        response.end(JSON.stringify({ nodes: [] }))
      } else {
        response.statusCode = 404
        response.end(JSON.stringify({ error: `Unexpected E2E API path: ${path}` }))
      }
    })
    await new Promise<void>((resolve, reject) => {
      accountFixtureServer!.once('error', reject)
      accountFixtureServer!.listen(0, '127.0.0.1', () => resolve())
    })
    const fixtureAddress = accountFixtureServer.address()
    if (!fixtureAddress || typeof fixtureAddress === 'string') {
      throw new Error('E2E account fixture server did not bind a TCP port')
    }
    const accountApiUrl = `http://127.0.0.1:${fixtureAddress.port}`
    const createCookieFixtureTab = async (
      workspaceId: 'local-personal' | 'e2e-team',
      tabId: string,
      cookiePath: string,
      useDefaultSession: boolean
    ): Promise<void> => {
      const partition =
        workspaceId === 'local-personal' ? 'persist:ola-browser' : 'persist:ola-browser-e2e-team'
      const created = await devToolsCall(socket!, 'Runtime.evaluate', {
        expression: `window.ola.ipc.invokeMessagePack('browser:view-create', {
          tabId: ${JSON.stringify(tabId)}, workspaceId: ${JSON.stringify(workspaceId)},
          profileId: ${JSON.stringify(useDefaultSession ? 'external-user-data' : partition)},
          ${useDefaultSession ? '' : `partition: ${JSON.stringify(partition)},`}
          bounds: { x: 1, y: 1, width: 10, height: 10 },
          url: ${JSON.stringify(`${accountApiUrl}${cookiePath}`)}
        })`,
        awaitPromise: true,
        returnByValue: true
      })
      expect(created.result?.value).toMatchObject({ success: true })
      const destroyed = await devToolsCall(socket!, 'Runtime.evaluate', {
        expression: `window.ola.ipc.invokeMessagePack('browser:view-destroy', { tabId: ${JSON.stringify(tabId)} })`,
        awaitPromise: true,
        returnByValue: true
      })
      expect(destroyed.result?.value).toMatchObject({ success: true })
    }
    const exportCookieCount = async (workspaceId: string): Promise<number> => {
      const exported = await devToolsCall(socket!, 'Runtime.evaluate', {
        expression: `window.ola.ipc.invokeMessagePack('browser:export-cookies', { workspaceId: ${JSON.stringify(workspaceId)} })`,
        awaitPromise: true,
        returnByValue: true
      })
      expect(exported.result?.value).toMatchObject({ success: true })
      return (exported.result?.value as { exported: number }).exported
    }
    const extensionManifestPath = join(extensionDirectory, 'extension.json')
    const extensionManifest = JSON.parse(await readFile(extensionManifestPath, 'utf8')) as {
      permissions?: { network?: string[] }
      tools: Array<Record<string, unknown>>
    }
    extensionManifest.permissions = { network: [`${accountApiUrl}/api/e2e-extension/*`] }
    for (const name of ['report_ok', 'report_fail']) {
      extensionManifest.tools.push({
        name,
        description: `Fetch the ${name} report from the isolated E2E fixture.`,
        kind: 'http',
        readOnly: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        http: {
          method: 'GET',
          url: `${accountApiUrl}/api/e2e-extension/${name.replace('_', '-')}`
        },
        artifact: { kind: 'link', urlPointer: '/report/url', titlePointer: '/report/name' }
      })
    }
    await writeFile(extensionManifestPath, JSON.stringify(extensionManifest), 'utf8')
    const providerConfig = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      'ola-providers': { state: { providers: Array<{ baseUrl: string }> } }
    }
    providerConfig['ola-providers'].state.providers[0].baseUrl = `${accountApiUrl}/v1`
    await writeFile(join(root, 'config.json'), JSON.stringify(providerConfig), 'utf8')
    const port = 11_000 + Math.floor(Math.random() * 39_000)
    const mainInspectorPort = port + 1
    child = spawn(
      packagedExe ?? electronBinary,
      [
        ...(packagedExe ? [] : [join(process.cwd(), 'out/main/index.js')]),
        '--no-sandbox',
        '--disable-gpu',
        `--inspect=127.0.0.1:${mainInspectorPort}`,
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${join(root, 'electron-user-data')}`
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, OLA_E2E_DATA_ROOT: root, OLA_STRICT_IPC_ALLOWLIST: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    child.stdout?.on('data', (chunk: Buffer) => {
      childLogs += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      childLogs += chunk.toString()
    })

    const target = await waitForPage(port)
    if (!target.webSocketDebuggerUrl) throw new Error('Electron renderer has no DevTools URL')
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await once(socket, 'open')
    const mainTarget = await waitForMainInspector(mainInspectorPort)
    if (!mainTarget.webSocketDebuggerUrl) throw new Error('Electron Main has no inspector URL')
    mainSocket = new WebSocket(mainTarget.webSocketDebuggerUrl)
    await once(mainSocket, 'open')
    await devToolsCall(socket, 'Runtime.enable')
    await devToolsCall(socket, 'Page.enable')
    if (process.env.TZ === 'Asia/Shanghai' || process.env.TZ === 'America/Los_Angeles') {
      const zoneOffset = await devToolsCall(socket, 'Runtime.evaluate', {
        expression: 'new Date(2026, 9, 4).getTimezoneOffset()',
        returnByValue: true
      })
      expect(zoneOffset.result?.value).toBe(process.env.TZ === 'Asia/Shanghai' ? -480 : 420)
    }

    await new Promise((resolve) => setTimeout(resolve, 4_000))
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `localStorage.setItem('ola.remote.account', ${JSON.stringify(JSON.stringify({ apiBaseUrl: accountApiUrl }))})`
    })
    const fixtureLogin = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('remote:account:invoke', { apiBaseUrl: ${JSON.stringify(accountApiUrl)}, operation: 'login', payload: { email: 'e2e@example.test', password: 'fixture-password' } })`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(fixtureLogin.result?.value).toMatchObject({
      account: { id: 'e2e-account', email: 'e2e@example.test' }
    })
    await devToolsCall(socket, 'Page.reload')
    await waitForExpression<boolean>(
      socket,
      `Boolean(document.querySelector('[data-testid="first-success-template-materials-report"]'))`,
      Boolean,
      'the first-success report template on the home page'
    )
    await waitForExpression<boolean>(
      socket,
      `Boolean(document.querySelector('[data-workspace-id="local-personal"]'))`,
      Boolean,
      'the local personal workspace tab before starting the model-backed scenario'
    )
    const selectPersonalWorkspace = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const tab = document.querySelector('[data-workspace-id="local-personal"]'); if (!tab) return false; tab.click(); return true })()`,
      returnByValue: true
    })
    expect(selectPersonalWorkspace.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `document.querySelector('[data-workspace-id="local-personal"]')?.getAttribute('aria-selected') === 'true'`,
      Boolean,
      'the local personal workspace to become active'
    )
    const browserMode = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('browser:emulation-status', {})`,
      awaitPromise: true,
      returnByValue: true
    })
    const personalUsesDefaultBrowser =
      (browserMode.result?.value as { status?: { reuseEnabled?: boolean } })?.status
        ?.reuseEnabled === true
    await createCookieFixtureTab(
      'local-personal',
      'e2e-personal-cookie-tab',
      '/api/e2e-browser-cookie-personal',
      personalUsesDefaultBrowser
    )
    expect(await exportCookieCount('local-personal')).toBe(1)
    const openProjectSelector = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = document.querySelector('button[aria-label="选择项目"], button[aria-label="Select project"]'); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(openProjectSelector.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `Boolean([...document.querySelectorAll('button[title]')].find((button) => button.getAttribute('title') === ${JSON.stringify(projectRoot)}))`,
      Boolean,
      'the seeded local project in the new-task selector'
    )
    const selectReviewProject = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = [...document.querySelectorAll('button[title]')].find((item) => item.getAttribute('title') === ${JSON.stringify(projectRoot)}); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(selectReviewProject.result?.value).toBe(true)
    const openProjectReview = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const card = document.querySelector('[data-testid="first-success-template-project-review"]'); if (!card) return false; card.click(); return true })()`,
      returnByValue: true
    })
    expect(openProjectReview.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `document.querySelector('[data-testid="first-success-template-use-prompt"]')?.disabled === false`,
      Boolean,
      'the local project directory preflight to pass'
    )
    const prepareProjectReview = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = document.querySelector('[data-testid="first-success-template-use-prompt"]'); if (!button || button.disabled) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(prepareProjectReview.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `(() => { const editor = document.querySelector('[role="textbox"][contenteditable="true"]'); const textArea = [...document.querySelectorAll('textarea')].find((field) => field.value.includes(${JSON.stringify(projectRoot)})); const prompt = textArea?.value ?? editor?.textContent ?? ''; return !document.querySelector('[data-testid="first-success-template-dialog"]') && prompt.includes(${JSON.stringify(projectRoot)}) && (prompt.includes('只读') || prompt.includes('READ-ONLY')) })()`,
      Boolean,
      'the prepared read-only project review prompt with the selected directory'
    )
    const reopenProjectSelector = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = document.querySelector('button[aria-label="选择项目"], button[aria-label="Select project"]'); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(reopenProjectSelector.result?.value).toBe(true)
    const clearReviewProject = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === '不选择项目' || item.textContent?.trim() === 'No project'); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(clearReviewProject.result?.value).toBe(true)
    const openMaterialsTemplate = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const card = document.querySelector('[data-testid="first-success-template-materials-report"]'); if (!card) return false; card.click(); return true })()`,
      returnByValue: true
    })
    expect(openMaterialsTemplate.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `Boolean(document.querySelector('[data-testid="first-success-template-dialog"]'))`,
      Boolean,
      'the scenario configuration dialog'
    )
    const fillScenarioFields = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const setValue = (selector, value) => { const field = document.querySelector(selector); if (!(field instanceof HTMLTextAreaElement)) return false; const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; setter?.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); return true }; return setValue('[data-testid="first-success-template-materials"]', 'Release notes: version 2 adds audit logging and fixes an upload timeout.') && setValue('[data-testid="first-success-template-scope"]', 'Summarize the release impact and list unresolved rollout risks.') })()`,
      returnByValue: true
    })
    expect(fillScenarioFields.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `document.querySelector('[data-testid="first-success-template-use-prompt"]')?.disabled === false`,
      Boolean,
      'the report template preflight to pass'
    )
    const dismissScenario = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const dialog = document.querySelector('[data-testid="first-success-template-dialog"]'); const cancel = [...(dialog?.querySelectorAll('button') ?? [])].find((button) => /^(Cancel|取消)$/.test(button.textContent?.trim() ?? '')); if (!cancel) return false; cancel.click(); return true })()`,
      returnByValue: true
    })
    expect(dismissScenario.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `!document.querySelector('[data-testid="first-success-template-dialog"]')`,
      Boolean,
      'the scenario dialog to close before temporary form recovery'
    )
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `document.querySelector('[data-testid="first-success-template-materials-report"]')?.click()`
    })
    await waitForExpression<boolean>(
      socket,
      `document.querySelector('[data-testid="first-success-template-materials"]')?.value === 'Release notes: version 2 adds audit logging and fixes an upload timeout.' && document.querySelector('[data-testid="first-success-template-scope"]')?.value === 'Summarize the release impact and list unresolved rollout risks.'`,
      Boolean,
      'unsaved scenario materials and scope to survive closing and reopening'
    )
    const saveScenarioScope = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = document.querySelector('[data-testid="first-success-template-save-scope"]'); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(saveScenarioScope.result?.value).toBe(true)
    await waitForExpression<string | null>(
      socket,
      `localStorage.getItem('ola.scenario-template.v1:local-personal:materials-report')`,
      (value) => value === 'Summarize the release impact and list unresolved rollout risks.',
      'the workspace-scoped saved report scope'
    )
    const prepareScenarioPrompt = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = document.querySelector('[data-testid="first-success-template-use-prompt"]'); if (!button || button.disabled) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(prepareScenarioPrompt.result?.value).toBe(true)
    await waitForExpression<{ dialogOpen: boolean; prompt: string }>(
      socket,
      `(() => { const editor = document.querySelector('[role="textbox"][contenteditable="true"]'); const textArea = [...document.querySelectorAll('textarea')].find((field) => field.value.includes('Release notes: version 2 adds audit logging')); return { dialogOpen: Boolean(document.querySelector('[data-testid="first-success-template-dialog"]')), prompt: textArea?.value ?? editor?.textContent ?? '' } })()`,
      (value) =>
        !value?.dialogOpen &&
        Boolean(value?.prompt.includes('Release notes: version 2 adds audit logging')),
      'the prepared prompt in the composer without sending it'
    )
    await waitForExpression<boolean>(
      socket,
      `Boolean(document.querySelector('[data-workspace-id="e2e-team"]'))`,
      Boolean,
      'the authenticated E2E team workspace tab'
    )
    const remoteWorkspaceTab = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const tab = document.querySelector('[data-workspace-id="e2e-team"]'); if (!tab) return false; tab.click(); return true })()`,
      returnByValue: true
    })
    expect(remoteWorkspaceTab.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `document.querySelector('[data-workspace-id="e2e-team"]')?.getAttribute('aria-selected') === 'true'`,
      Boolean,
      'the E2E team workspace to become active'
    )
    await waitForPageText(
      socket,
      (text) => text.includes('Remote workspace only session'),
      'the session owned by the active team workspace'
    )
    const remoteSessionIsolation = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `({ remote: document.body.innerText.includes('Remote workspace only session'), localQueue: document.body.innerText.includes('Queue recovery e2e session'), localTerminal: document.body.innerText.includes('Terminal dock e2e session') })`,
      returnByValue: true
    })
    expect(remoteSessionIsolation.result?.value).toEqual({
      remote: true,
      localQueue: false,
      localTerminal: false
    })
    const teamRegistration = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('window:workspace:set', { workspaceId: 'e2e-team' })`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(teamRegistration.result?.value).toMatchObject({ workspaceId: 'e2e-team' })
    expect(await exportCookieCount('e2e-team')).toBe(0)
    await createCookieFixtureTab(
      'e2e-team',
      'e2e-team-cookie-tab',
      '/api/e2e-browser-cookie-team',
      false
    )
    expect(
      cookieFixtureRequests.find((request) => request.path === '/api/e2e-browser-cookie-team')
        ?.cookie
    ).not.toContain('ola-e2e-personal=personal-value')
    expect(await exportCookieCount('e2e-team')).toBe(1)
    const clearTeamCookies = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('browser:clear-cookies', { workspaceId: 'e2e-team' })`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(clearTeamCookies.result?.value).toMatchObject({ success: true })
    expect(await exportCookieCount('e2e-team')).toBe(0)
    await waitForExpression<boolean>(
      socket,
      `(() => { const tab = document.querySelector('[data-workspace-id="local-personal"]'); if (!tab) return false; if (tab.getAttribute('aria-selected') !== 'true') tab.click(); return tab.getAttribute('aria-selected') === 'true' })()`,
      Boolean,
      'the personal workspace to become active again'
    )
    await waitForPageText(
      socket,
      (text) => text.includes('Queue recovery e2e session'),
      'the personal workspace sessions after switching back'
    )
    const personalSessionIsolation = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `({ localQueue: document.body.innerText.includes('Queue recovery e2e session'), localTerminal: document.body.innerText.includes('Terminal dock e2e session'), remote: document.body.innerText.includes('Remote workspace only session') })`,
      returnByValue: true
    })
    expect(personalSessionIsolation.result?.value).toEqual({
      localQueue: true,
      localTerminal: true,
      remote: false
    })
    expect(await exportCookieCount('local-personal')).toBe(1)
    const openTasks = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => ['Tasks', '任务', 'Tasks & automation', '任务与自动化'].includes(item.getAttribute('aria-label') ?? item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(openTasks.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `Boolean(Array.from(document.querySelectorAll('button')).find((item) => ['Recent runs', 'All runs', '最近运行', '全部运行'].includes(item.textContent?.trim() ?? '')))`,
      Boolean,
      'the recent runs entry on the tasks page'
    )
    const openRuns = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => ['Recent runs', 'All runs', '最近运行', '全部运行'].includes(item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(openRuns.result?.value).toBe(true)
    await waitForPageText(
      socket,
      (text) => text.includes('Runs and attention') || text.includes('运行与待处理'),
      'the unified runs center'
    )
    await waitForPageText(
      socket,
      (text) => text.includes('artifact-run-e2e'),
      'the persisted run after the scoped IPC request'
    )
    await waitForPageText(
      socket,
      (text) =>
        (text.includes("This run's results") || text.includes('本次产物')) &&
        text.includes('e2e-confirmed-result.md'),
      'the confirmed file under the persisted run details'
    )
    const loadOlderRuns = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => ['Load more runs', '加载更多运行'].includes(item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(loadOlderRuns.result?.value).toBe(true)
    await waitForPageText(
      socket,
      (text) => text.includes('History run 000'),
      'the older run after loading the second history page'
    )
    const cronRuns = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('cron:runs', { workspaceId: 'local-personal', limit: 200 })`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(cronRuns.result?.value).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'cron-delivery-run-ui-e2e',
          jobNameSnapshot: 'Cron delivery reconciliation E2E'
        })
      ])
    )
    const cronRunDetail = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('cron:run-detail', { runId: 'cron-delivery-run-ui-e2e', workspaceId: 'local-personal' })`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(cronRunDetail.result?.value).toMatchObject({
      deliveries: [
        expect.objectContaining({ id: 'cron-delivery-unknown-ui-e2e', status: 'unknown' })
      ]
    })
    const selectUnknownCronDelivery = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const buttons = Array.from(document.querySelectorAll('button')); const row = buttons.find((item) => item.textContent?.includes('Cron delivery reconciliation E2E')); if (!row) return { found: false, matchingText: buttons.map((item) => item.textContent?.trim()).filter((text) => text?.includes('delivery') || text?.includes('Scheduled')).slice(0, 15), body: document.body.innerText.slice(0, 800) }; row.click(); return { found: true } })()`,
      returnByValue: true
    })
    expect(selectUnknownCronDelivery.result?.value).toEqual({ found: true })
    await waitForExpression<boolean>(
      socket,
      `(document.body.innerText.includes('Delivery status') || document.body.innerText.includes('投递状态')) && (document.body.innerText.includes('Needs verification') || document.body.innerText.includes('待核对')) && Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.includes('Confirm delivered') || button.textContent?.includes('确认已送达'))`,
      Boolean,
      'the unknown Cron delivery reconciliation controls'
    )
    const confirmCronDeliverySent = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.includes('Confirm delivered') || item.textContent?.includes('确认已送达')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(confirmCronDeliverySent.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `(document.body.innerText.includes('Sent') || document.body.innerText.includes('已送达')) && !Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.includes('Confirm delivered') || button.textContent?.includes('确认已送达'))`,
      Boolean,
      'the reconciled Cron delivery status'
    )
    const reconciledCronDelivery = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('cron:run-detail', { runId: 'cron-delivery-run-ui-e2e', workspaceId: 'local-personal' })`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(reconciledCronDelivery.result?.value).toMatchObject({
      deliveries: [expect.objectContaining({ id: 'cron-delivery-unknown-ui-e2e', status: 'sent' })]
    })
    const showAttention = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => /^(Needs attention|需要处理)/.test(item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(showAttention.result?.value).toBe(true)
    await waitForPageText(
      socket,
      (text) =>
        text.includes('History run 000') &&
        (text.includes('Needs attention (1 loaded)') || text.includes('需要处理（已加载 1 条）')),
      'the older failed run in the data-source attention filter'
    )
    const selectFailedHistoryRun = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const item = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('History run 000')); if (!item) return false; item.click(); return true })()`,
      returnByValue: true
    })
    expect(selectFailedHistoryRun.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `Boolean(document.querySelector('[data-testid="execution-center-retry-draft"]'))`,
      Boolean,
      'the reviewed retry-draft action for a failed ordinary chat run'
    )
    const prepareRetryDraft = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = document.querySelector('[data-testid="execution-center-retry-draft"]'); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(prepareRetryDraft.result?.value).toBe(true)
    const retryDraftVisible = `location.hash.includes('session-terminal-e2e') && Boolean(document.querySelector('[role="textbox"][contenteditable="true"]')?.textContent?.includes('Historical run'))`
    await waitForExpression<boolean>(
      socket,
      retryDraftVisible,
      Boolean,
      'the failed run prompt to appear as an editable source-session draft without sending'
    )
    await devToolsCall(socket, 'Page.reload')
    await waitForExpression<boolean>(
      socket,
      retryDraftVisible,
      Boolean,
      'the reviewed retry draft to survive an Electron renderer restart'
    )
    const returnToTasksAfterDraft = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => ['Tasks', '任务', 'Tasks & automation', '任务与自动化'].includes(item.getAttribute('aria-label') ?? item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(returnToTasksAfterDraft.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      'Boolean(Array.from(document.querySelectorAll("button")).find((item) => /^(Recent runs|All runs|最近运行|全部运行)$/.test(item.textContent?.trim() ?? "")))',
      Boolean,
      'the recent runs entry after returning from the restored source-session draft'
    )
    const reopenRunsAfterDraft = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => ['Recent runs', 'All runs', '最近运行', '全部运行'].includes(item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(reopenRunsAfterDraft.result?.value).toBe(true)
    await waitForPageText(
      socket,
      (text) => text.includes('Runs and attention') || text.includes('运行与待处理'),
      'the runs center after restoring the source-session draft'
    )
    const showAttentionAfterDraft = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => /^(Needs attention|需要处理)/.test(item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(showAttentionAfterDraft.result?.value).toBe(true)
    await waitForPageText(
      socket,
      (text) => text.includes('History run 000'),
      'the same failed run to remain in history, proving draft preparation did not create a retry run'
    )
    const returnToSchedule = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = document.querySelector('button[aria-label="Back to schedule"], button[aria-label="返回排期"]'); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(returnToSchedule.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `Boolean(Array.from(document.querySelectorAll('button')).find((item) => ['Results', '结果'].includes(item.textContent?.trim() ?? '')))`,
      Boolean,
      'the results entry on the tasks page'
    )
    const openResults = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => ['Results', '结果'].includes(item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(openResults.result?.value).toBe(true)
    await waitForPageText(
      socket,
      (text) => text.includes('e2e-confirmed-result.md'),
      'the confirmed result restored from the runtime journal'
    )
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `document.querySelector('button[aria-label="Back"], button[aria-label="返回"]')?.click()`
    })
    await waitForExpression<boolean>(
      socket,
      `Boolean(Array.from(document.querySelectorAll('button')).find((item) => ['Board', '看板', '任务看板'].includes(item.textContent?.trim() ?? '')))`,
      Boolean,
      'the task board entry after returning to schedule'
    )
    const openBoard = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => ['Board', '看板', '任务看板'].includes(item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(openBoard.result?.value).toBe(true)
    const openDashboard = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => ['Dashboard', '概览'].includes(item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(openDashboard.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `(() => { const cards = Array.from(document.querySelectorAll('main .rounded-xl.border.bg-background.p-4.shadow-sm')).map((item) => item.textContent?.replace(/\\s+/g, '') ?? ''); return (cards.includes('Total tasks7') || cards.includes('任务总数7')) && (cards.includes('Failed1') || cards.includes('失败1')) && (cards.includes('Cancelled1') || cards.includes('已取消1')) })()`,
      Boolean,
      'the dashboard total and both terminal status counts'
    )
    const openKanban = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => ['Kanban', '看板'].includes(item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(openKanban.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `(() => { const grid = document.querySelector('main .grid.grid-cols-7'); const scroller = grid?.parentElement; const last = grid?.lastElementChild; if (!scroller || !last) return false; last.scrollIntoView({ block: 'nearest', inline: 'end', behavior: 'instant' }); const right = last.getBoundingClientRect().right; return right <= scroller.getBoundingClientRect().right + 1 && (last.textContent?.includes('Cancelled') || last.textContent?.includes('已取消')) })()`,
      Boolean,
      'the cancelled Kanban column after horizontal scrolling'
    )
    await waitForExpression<boolean>(
      socket,
      `Boolean(Array.from(document.querySelectorAll('button')).find((item) => ['List', '列表'].includes(item.textContent?.trim() ?? '')))`,
      Boolean,
      'the task board list view'
    )
    const openTaskList = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => ['List', '列表'].includes(item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(openTaskList.result?.value).toBe(true)
    await waitForPageText(
      socket,
      (text) => text.includes('Linked run entry E2E task'),
      'the persisted business task on the board'
    )
    const unavailableTasksDb = new DatabaseSync(join(root, 'data.db'))
    unavailableTasksDb.exec('ALTER TABLE tasks RENAME TO tasks_e2e_temporarily_unavailable')
    unavailableTasksDb.close()
    try {
      await devToolsCall(socket, 'Runtime.evaluate', {
        expression: `document.querySelector('button[aria-label="刷新任务看板"], button[aria-label="Refresh task board"]')?.click()`
      })
      await waitForExpression<boolean>(
        socket,
        `Boolean([...document.querySelectorAll('main [role="alert"]')].find((item) => /Failed to load tasks|加载任务失败/.test(item.textContent || '') && [...item.querySelectorAll('button')].some((button) => /Retry|重试/.test(button.textContent || ''))))`,
        Boolean,
        'a visible task-board load failure with a retry action'
      )
    } finally {
      const restoredTasksDb = new DatabaseSync(join(root, 'data.db'))
      restoredTasksDb.exec('ALTER TABLE tasks_e2e_temporarily_unavailable RENAME TO tasks')
      restoredTasksDb.close()
    }
    const retryBoardLoad = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const alert = [...document.querySelectorAll('main [role="alert"]')].find((item) => /Failed to load tasks|加载任务失败/.test(item.textContent || '')); const button = [...(alert?.querySelectorAll('button') ?? [])].find((item) => /Retry|重试/.test(item.textContent || '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(retryBoardLoad.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `document.body.innerText.includes('Linked run entry E2E task') && ![...document.querySelectorAll('main [role="alert"]')].some((item) => /Failed to load tasks|加载任务失败/.test(item.textContent || ''))`,
      Boolean,
      'the task board to recover after retry'
    )
    const createTaskFailureDb = new DatabaseSync(join(root, 'data.db'))
    createTaskFailureDb.exec(`CREATE TRIGGER reject_task_create_e2e BEFORE INSERT ON tasks
      BEGIN SELECT RAISE(ABORT, 'e2e task create failure'); END`)
    createTaskFailureDb.close()
    const openCreateTask = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = [...document.querySelectorAll('header button')].find((item) => /New task|新建任务/.test(item.textContent || '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(openCreateTask.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `Boolean(document.querySelector('[role="dialog"] input'))`,
      Boolean,
      'the new task dialog'
    )
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `document.querySelector('[role="dialog"] input')?.focus()`
    })
    await devToolsCall(socket, 'Input.insertText', { text: 'E2E created task' })
    const submitCreateTask = async (): Promise<void> => {
      const result = await devToolsCall(socket!, 'Runtime.evaluate', {
        expression: `(() => { const button = [...document.querySelectorAll('[role="dialog"] button')].find((item) => /New task|新建任务/.test(item.textContent || '')); if (!button) return false; button.click(); return true })()`,
        returnByValue: true
      })
      expect(result.result?.value).toBe(true)
    }
    await submitCreateTask()
    await waitForExpression<boolean>(
      socket,
      `Boolean([...document.querySelectorAll('[role="dialog"] [role="alert"]')].find((item) => /Could not create|创建任务失败/.test(item.textContent || '')))`,
      Boolean,
      'the task creation failure feedback'
    )
    const createDraft = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `document.querySelector('[role="dialog"] input')?.value`,
      returnByValue: true
    })
    expect(createDraft.result?.value).toBe('E2E created task')
    const createFailureCheckDb = new DatabaseSync(join(root, 'data.db'), { readOnly: true })
    expect(
      (
        createFailureCheckDb
          .prepare("SELECT COUNT(*) AS count FROM tasks WHERE subject='E2E created task'")
          .get() as { count: number }
      ).count
    ).toBe(0)
    createFailureCheckDb.close()
    const restoreTaskCreationDb = new DatabaseSync(join(root, 'data.db'))
    restoreTaskCreationDb.exec('DROP TRIGGER reject_task_create_e2e')
    restoreTaskCreationDb.close()
    await submitCreateTask()
    await waitForPageText(
      socket,
      (text) => text.includes('E2E created task'),
      'the created task to appear on the board'
    )
    await waitForExpression<boolean>(
      socket,
      `!document.querySelector('[role="dialog"]')`,
      Boolean,
      'the creation dialog to close after a confirmed write'
    )
    const createdTaskDb = new DatabaseSync(join(root, 'data.db'), { readOnly: true })
    const createdTaskRow = createdTaskDb
      .prepare("SELECT id FROM tasks WHERE subject='E2E created task'")
      .get() as { id: string } | undefined
    expect(createdTaskRow?.id).toBeTruthy()
    createdTaskDb.close()
    const deleteTaskFailureDb = new DatabaseSync(join(root, 'data.db'))
    deleteTaskFailureDb.exec(`CREATE TRIGGER reject_task_delete_e2e BEFORE DELETE ON tasks
      WHEN OLD.id = '${createdTaskRow!.id}'
      BEGIN SELECT RAISE(ABORT, 'e2e task delete failure'); END`)
    deleteTaskFailureDb.close()
    const openDeleteTask = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = [...document.querySelectorAll('aside button')].find((item) => /Delete task|删除任务/.test(item.textContent || '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(openDeleteTask.result?.value).toBe(true)
    const confirmDeleteTask = async (): Promise<void> => {
      const result = await devToolsCall(socket!, 'Runtime.evaluate', {
        expression: `(() => { const button = [...document.querySelectorAll('[role="dialog"] button')].find((item) => /Delete task|删除任务/.test(item.textContent || '')); if (!button) return false; button.click(); return true })()`,
        returnByValue: true
      })
      expect(result.result?.value).toBe(true)
    }
    await confirmDeleteTask()
    await waitForExpression<boolean>(
      socket,
      `Boolean([...document.querySelectorAll('[role="dialog"] [role="alert"]')].find((item) => /Could not delete|删除任务失败/.test(item.textContent || '')))`,
      Boolean,
      'the task deletion failure feedback'
    )
    const deleteFailureCheckDb = new DatabaseSync(join(root, 'data.db'), { readOnly: true })
    expect(
      (
        deleteFailureCheckDb
          .prepare('SELECT COUNT(*) AS count FROM tasks WHERE id = ?')
          .get(createdTaskRow!.id) as { count: number }
      ).count
    ).toBe(1)
    deleteFailureCheckDb.close()
    const restoreTaskDeletionDb = new DatabaseSync(join(root, 'data.db'))
    restoreTaskDeletionDb.exec('DROP TRIGGER reject_task_delete_e2e')
    restoreTaskDeletionDb.close()
    await confirmDeleteTask()
    await waitForExpression<boolean>(
      socket,
      `!document.querySelector('[role="dialog"]') && !document.body.innerText.includes('E2E created task')`,
      Boolean,
      'the task to disappear after a confirmed delete'
    )
    const deletedTaskDb = new DatabaseSync(join(root, 'data.db'), { readOnly: true })
    expect(
      (
        deletedTaskDb
          .prepare('SELECT COUNT(*) AS count FROM tasks WHERE id = ?')
          .get(createdTaskRow!.id) as { count: number }
      ).count
    ).toBe(0)
    deletedTaskDb.close()
    const openPersistedTask = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = [...document.querySelectorAll('header button')].find((item) => /New task|新建任务/.test(item.textContent || '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(openPersistedTask.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `Boolean(document.querySelector('[role="dialog"] input'))`,
      Boolean,
      'the new task dialog for restart persistence'
    )
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `document.querySelector('[role="dialog"] input')?.focus()`
    })
    await devToolsCall(socket, 'Input.insertText', { text: 'E2E persisted created task' })
    await submitCreateTask()
    await waitForExpression<boolean>(
      socket,
      `!document.querySelector('[role="dialog"]') && document.body.innerText.includes('E2E persisted created task')`,
      Boolean,
      'the new task to be saved before restart'
    )
    for (const status of [
      'in_progress',
      'in_review',
      'blocked',
      'completed',
      'failed',
      'cancelled'
    ] as const) {
      const selectTerminalTask = await devToolsCall(socket, 'Runtime.evaluate', {
        expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.includes('${status} E2E task')); if (!button) return false; button.click(); return true })()`,
        returnByValue: true
      })
      expect(selectTerminalTask.result?.value).toBe(true)
      await waitForExpression<boolean>(
        socket,
        `(() => { const aside = Array.from(document.querySelectorAll('aside')).find((item) => item.textContent?.includes('Task details') || item.textContent?.includes('任务详情')); return aside?.querySelector('select')?.value === '${status}' })()`,
        Boolean,
        `the ${status} task status in details`
      )
    }
    const selectBusinessTask = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.includes('Linked run entry E2E task')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(selectBusinessTask.result?.value).toBe(true)
    await waitForPageText(
      socket,
      (text) => text.includes('Run in session') || text.includes('在会话中执行'),
      'the linked task run action in its details'
    )
    const taskKeyboardDetails = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => {
        const aside = [...document.querySelectorAll('aside')].find((item) => /Task details|任务详情/.test(item.textContent || ''))
        const subject = aside?.querySelector('input')
        const status = aside?.querySelector('select')
        const priority = aside?.querySelectorAll('select')[1]
        const localized = /任务详情/.test(aside?.textContent || '')
        return {
          subjectLabel: subject?.getAttribute('aria-label'),
          statusLabel: status?.getAttribute('aria-label'),
          priorities: [...(priority?.options ?? [])].map((option) => option.textContent?.trim()),
          rowFocusStyle: [...document.querySelectorAll('main button')].some((button) =>
            button.textContent?.includes('Linked run entry E2E task') &&
            button.classList.contains('focus-visible:ring-2')
          ),
          localized
        }
      })()`,
      returnByValue: true
    })
    const keyboardDetails = taskKeyboardDetails.result?.value as {
      localized: boolean
      subjectLabel: string
      statusLabel: string
      priorities: string[]
      rowFocusStyle: boolean
    }
    expect(keyboardDetails.subjectLabel).toBe(keyboardDetails.localized ? '任务' : 'Task')
    expect(keyboardDetails.statusLabel).toBe(keyboardDetails.localized ? '状态' : 'Status')
    expect(keyboardDetails.rowFocusStyle).toBe(true)
    expect(keyboardDetails.priorities).toEqual(
      keyboardDetails.localized ? ['低', '中', '高', '紧急'] : ['Low', 'Medium', 'High', 'Urgent']
    )
    await devToolsCall(socket, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9
    })
    await devToolsCall(socket, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9
    })
    const taskRowFocus = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => {
        const row = [...document.querySelectorAll('main button')].find((button) =>
          button.textContent?.includes('Linked run entry E2E task'))
        row?.focus()
        return {
          active: document.activeElement === row,
          visible: row?.matches(':focus-visible'),
          ring: row ? getComputedStyle(row).boxShadow : 'none'
        }
      })()`,
      returnByValue: true
    })
    expect(taskRowFocus.result?.value).toMatchObject({ active: true, visible: true })
    expect((taskRowFocus.result?.value as { ring: string }).ring).not.toBe('none')
    for (const zoom of [1, 1.25, 1.5]) {
      await devToolsCall(socket, 'Emulation.setDeviceMetricsOverride', {
        width: Math.round(760 / zoom),
        height: Math.round(560 / zoom),
        deviceScaleFactor: zoom,
        mobile: false
      })
      const boardLayout = await waitForExpression<{
        viewportWidth: number
        documentWidth: number
        mainWidth: number
        detailWidth: number
        mainBottom: number
        detailTop: number
        detailBottom: number
        viewportHeight: number
      }>(
        socket,
        `(() => {
          const detail = [...document.querySelectorAll('aside')].find((item) => /Task details|任务详情/.test(item.textContent || ''))
          const main = detail?.previousElementSibling
          const detailRect = detail?.getBoundingClientRect()
          const mainRect = main?.getBoundingClientRect()
          return {
            viewportWidth: window.innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            mainWidth: mainRect?.width ?? 0,
            detailWidth: detailRect?.width ?? 0,
            mainBottom: mainRect?.bottom ?? 0,
            detailTop: detailRect?.top ?? 0,
            detailBottom: detailRect?.bottom ?? 0,
            viewportHeight: window.innerHeight
          }
        })()`,
        (layout) => Boolean(layout && layout.mainWidth >= 280 && layout.detailWidth),
        `the selected task layout at ${zoom * 100}% equivalent zoom`
      )
      expect(boardLayout.documentWidth, JSON.stringify(boardLayout)).toBeLessThanOrEqual(
        boardLayout.viewportWidth
      )
      expect(boardLayout.mainWidth, JSON.stringify(boardLayout)).toBeGreaterThanOrEqual(280)
      expect(boardLayout.detailTop, JSON.stringify(boardLayout)).toBeGreaterThanOrEqual(
        boardLayout.mainBottom - 1
      )
      expect(boardLayout.detailBottom, JSON.stringify(boardLayout)).toBeLessThanOrEqual(
        boardLayout.viewportHeight + 1
      )
    }
    await devToolsCall(socket, 'Emulation.clearDeviceMetricsOverride')
    const taskUpdateFailureDb = new DatabaseSync(join(root, 'data.db'))
    taskUpdateFailureDb.exec(`
      CREATE TRIGGER reject_task_detail_update
      BEFORE UPDATE ON tasks
      WHEN NEW.id = 'business-task-e2e'
      BEGIN
        SELECT RAISE(ABORT, 'injected task detail update failure');
      END;
    `)
    taskUpdateFailureDb.close()
    const editTaskSubject = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const aside = [...document.querySelectorAll('aside')].find((item) => /Task details|任务详情/.test(item.textContent || '')); const input = aside?.querySelector('input'); if (!input) return false; input.focus(); input.select(); return true })()`,
      returnByValue: true
    })
    expect(editTaskSubject.result?.value).toBe(true)
    await devToolsCall(socket, 'Input.insertText', { text: 'Linked run entry E2E task edited' })
    await waitForExpression<boolean>(
      socket,
      `Boolean([...document.querySelectorAll('aside button')].find((button) => /Save changes|保存修改/.test(button.textContent || '')))`,
      Boolean,
      'the task detail save action'
    )
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `([...document.querySelectorAll('aside button')].find((button) => /Save changes|保存修改/.test(button.textContent || '')))?.click()`
    })
    await waitForExpression<boolean>(
      socket,
      `Boolean([...document.querySelectorAll('aside [role="alert"]')].find((item) => /Could not save|保存失败/.test(item.textContent || '')))`,
      Boolean,
      'the task detail save failure feedback'
    )
    const taskDraftAfterFailure = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `([...document.querySelectorAll('aside')].find((item) => /Task details|任务详情/.test(item.textContent || ''))?.querySelector('input'))?.value`,
      returnByValue: true
    })
    expect(taskDraftAfterFailure.result?.value).toBe('Linked run entry E2E task edited')
    const unchangedTaskDb = new DatabaseSync(join(root, 'data.db'), { readOnly: true })
    expect(
      (
        unchangedTaskDb.prepare("SELECT subject FROM tasks WHERE id='business-task-e2e'").get() as {
          subject: string
        }
      ).subject
    ).toBe('Linked run entry E2E task')
    unchangedTaskDb.close()
    const restoredTaskDb = new DatabaseSync(join(root, 'data.db'))
    restoredTaskDb.exec('DROP TRIGGER reject_task_detail_update')
    restoredTaskDb.close()
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `([...document.querySelectorAll('aside button')].find((button) => /Retry save|重试保存/.test(button.textContent || '')))?.click()`
    })
    await waitForExpression<boolean>(
      socket,
      `document.body.innerText.includes('Linked run entry E2E task edited') && ![...document.querySelectorAll('aside [role="alert"]')].some((item) => /Could not save|保存失败/.test(item.textContent || ''))`,
      Boolean,
      'the task detail to be saved after retry'
    )
    const savedTaskDb = new DatabaseSync(join(root, 'data.db'), { readOnly: true })
    expect(
      (
        savedTaskDb.prepare("SELECT subject FROM tasks WHERE id='business-task-e2e'").get() as {
          subject: string
        }
      ).subject
    ).toBe('Linked run entry E2E task edited')
    savedTaskDb.close()
    const setDueDate = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const aside = [...document.querySelectorAll('aside')].find((item) => /Task details|任务详情/.test(item.textContent || '')); const input = aside?.querySelectorAll('input[type="date"]')[1]; if (!input) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '2026-10-04'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); return true })()`,
      returnByValue: true
    })
    expect(setDueDate.result?.value).toBe(true)
    const dateDb = new DatabaseSync(join(root, 'data.db'), { readOnly: true })
    let storedDueDate: string | undefined
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const row = dateDb
        .prepare("SELECT metadata FROM tasks WHERE id='business-task-e2e'")
        .get() as { metadata: string }
      storedDueDate = (JSON.parse(row.metadata) as { board?: { dueDate?: string } }).board?.dueDate
      if (storedDueDate === '2026-10-04') break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    dateDb.close()
    expect(storedDueDate).toBe('2026-10-04')
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `document.querySelector('button[aria-label="刷新任务看板"], button[aria-label="Refresh task board"]')?.click()`
    })
    await waitForExpression<boolean>(
      socket,
      `([...document.querySelectorAll('aside')].find((item) => /Task details|任务详情/.test(item.textContent || ''))?.querySelectorAll('input[type="date"]')[1])?.value === '2026-10-04'`,
      Boolean,
      'the same due date after refreshing the board'
    )
    const switchBoardWorkspace = async (workspaceId: string): Promise<void> => {
      const revealWorkspaceSwitcher = await devToolsCall(socket!, 'Runtime.evaluate', {
        expression: `(() => { if (document.querySelector('#ola-workspace-switcher')) return true; const toggle = document.querySelector('.workspace-titlebar-surface button.workspace-titlebar-action'); if (!toggle) return false; toggle.click(); return true })()`,
        returnByValue: true
      })
      expect(revealWorkspaceSwitcher.result?.value).toBe(true)
      await waitForExpression<boolean>(
        socket!,
        `Boolean(document.querySelector('#ola-workspace-switcher'))`,
        Boolean,
        'the workspace switcher after revealing the sidebar'
      )
      const changed = await devToolsCall(socket!, 'Runtime.evaluate', {
        expression: `(() => { const select = document.querySelector('#ola-workspace-switcher'); if (!select) return false; const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(select, ${JSON.stringify(workspaceId)}); select.dispatchEvent(new Event('change', { bubbles: true })); return true })()`,
        returnByValue: true
      })
      expect(changed.result?.value).toBe(true)
      await waitForExpression<boolean>(
        socket!,
        `document.querySelector('#ola-workspace-switcher')?.value === ${JSON.stringify(workspaceId)}`,
        Boolean,
        `the active workspace to become ${workspaceId}`
      )
      const reopenedTasks = await devToolsCall(socket!, 'Runtime.evaluate', {
        expression: `(() => { const button = [...document.querySelectorAll('button')].find((item) => ['Tasks', '任务', 'Tasks & automation', '任务与自动化'].includes(item.getAttribute('aria-label') ?? item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
        returnByValue: true
      })
      expect(reopenedTasks.result?.value).toBe(true)
      await waitForExpression<boolean>(
        socket!,
        `Boolean([...document.querySelectorAll('button')].find((item) => ['Board', '看板', '任务看板'].includes(item.textContent?.trim() ?? '')))`,
        Boolean,
        'the board entry after switching workspaces'
      )
      await devToolsCall(socket!, 'Runtime.evaluate', {
        expression: `([...document.querySelectorAll('button')].find((item) => ['Board', '看板', '任务看板'].includes(item.textContent?.trim() ?? '')))?.click()`
      })
      await devToolsCall(socket!, 'Runtime.evaluate', {
        expression: `([...document.querySelectorAll('button')].find((item) => ['List', '列表'].includes(item.textContent?.trim() ?? '')))?.click()`
      })
    }
    const installDelayedTaskList = await devToolsCall(mainSocket!, 'Runtime.evaluate', {
      expression: `(() => {
        const { ipcMain } = process.getBuiltinModule('module').createRequire(process.execPath)('electron')
        const channel = 'db:tasks:list-all:msgpack'
        const original = ipcMain._invokeHandlers.get(channel)
        if (typeof original !== 'function') return false
        const gate = { held: false, released: false, release: null, original }
        globalThis.__olaTaskListGate = gate
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, async (...args) => {
          const result = await original(...args)
          if (!gate.held) {
            gate.held = true
            await new Promise((resolve) => {
              gate.release = () => { gate.released = true; resolve() }
            })
          }
          return result
        })
        return true
      })()`,
      returnByValue: true
    })
    expect(installDelayedTaskList.result?.value).toBe(true)
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `document.querySelector('button[aria-label="刷新任务看板"], button[aria-label="Refresh task board"]')?.click()`
    })
    await waitForExpression<boolean>(
      mainSocket!,
      `globalThis.__olaTaskListGate?.held === true`,
      Boolean,
      'the personal task-list response to be held after its database read'
    )
    await switchBoardWorkspace('e2e-team')
    await waitForPageText(
      socket,
      (text) => text.includes('Team workspace E2E task'),
      'the team task to appear on its board'
    )
    await waitForExpression<boolean>(
      socket,
      `!document.body.innerText.includes('Linked run entry E2E task edited')`,
      Boolean,
      'the team board to exclude the personal task'
    )
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => {
        const audit = { leaked: false, observer: null }
        const inspect = () => {
          if (document.body.innerText.includes('Linked run entry E2E task edited')) audit.leaked = true
        }
        audit.observer = new MutationObserver(inspect)
        audit.observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        inspect()
        window.__olaTaskBoardLeakAudit = audit
      })()`
    })
    await devToolsCall(mainSocket!, 'Runtime.evaluate', {
      expression: `globalThis.__olaTaskListGate.release()`
    })
    await waitForExpression<boolean>(
      mainSocket!,
      `globalThis.__olaTaskListGate?.released === true`,
      Boolean,
      'the delayed personal task-list response to be released'
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    const staleTaskLeak = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => {
        const audit = window.__olaTaskBoardLeakAudit
        audit.observer.disconnect()
        return { leaked: audit.leaked, teamVisible: document.body.innerText.includes('Team workspace E2E task') }
      })()`,
      returnByValue: true
    })
    expect(staleTaskLeak.result?.value).toEqual({ leaked: false, teamVisible: true })
    await devToolsCall(mainSocket!, 'Runtime.evaluate', {
      expression: `(() => {
        const { ipcMain } = process.getBuiltinModule('module').createRequire(process.execPath)('electron')
        ipcMain.removeHandler('db:tasks:list-all:msgpack')
        ipcMain.handle('db:tasks:list-all:msgpack', globalThis.__olaTaskListGate.original)
        delete globalThis.__olaTaskListGate
      })()`
    })
    await switchBoardWorkspace('local-personal')
    await waitForPageText(
      socket,
      (text) => text.includes('Linked run entry E2E task edited'),
      'the personal task to return on its board'
    )
    await waitForExpression<boolean>(
      socket,
      `!document.body.innerText.includes('Team workspace E2E task')`,
      Boolean,
      'the personal board to exclude the team task'
    )
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: 'window.location.hash = "#/chat/session-queue-e2e"'
    })
    const queueText = await waitForPageText(
      socket,
      (text) =>
        text.includes('Interrupted message for review') &&
        text.includes('Second message stays queued') &&
        (text.includes('Check before retry') || text.includes('重试前请确认')),
      'the paused queue with an interrupted message marked for review'
    )

    expect(queueText).toMatch(/(Retry|重试发送)/)
    const buttonResult = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `Array.from(document.querySelectorAll('button')).some((button) =>
          /^(Retry|重试发送)$/.test(button.getAttribute('aria-label') || button.textContent?.trim() || '')
        )`,
      returnByValue: true
    })
    expect(buttonResult.result?.value).toBe(true)

    await waitForExpression<boolean>(
      socket,
      `Array.from(document.querySelectorAll('button[title]')).some((button) => button.title.startsWith('Long message layout sentinel'))`,
      Boolean,
      'the long queued message summary'
    )
    await devToolsCall(socket, 'Emulation.setDeviceMetricsOverride', {
      width: 760,
      height: 560,
      deviceScaleFactor: 1,
      mobile: false
    })
    const narrowQueueLayout = await waitForExpression<{
      viewportWidth: number
      documentWidth: number
      queueVisible: boolean
      queueWithinViewport: boolean
      queueFullyVisible: boolean
      summaryLength: number
      actionWithinViewport: boolean
      actionFullyVisible: boolean
      composerEditorFullyVisible: boolean
      sendButtonFullyVisible: boolean
      sendButtonBottom: number
      runtimePanelVisible: boolean
      runtimePanelBottom: number
      queueTop: number
    }>(
      socket,
      `(() => {
        const queue = document.querySelector('.max-h-40.overflow-y-auto')
        const summary = Array.from(document.querySelectorAll('button[title]')).find((button) => button.title.startsWith('Long message layout sentinel'))
        const action = Array.from(document.querySelectorAll('button')).find((button) => /^(Retry|重试发送)$/.test(button.getAttribute('aria-label') || button.textContent?.trim() || ''))
        const editor = document.querySelector('.composer-editor-content[contenteditable="true"]')
        const sendButton = document.querySelector('.composer-send')
        const runtimeHeading = Array.from(document.querySelectorAll('h3')).find((heading) => /环境信息|Environment/.test(heading.textContent || ''))
        const runtimePanel = runtimeHeading?.closest('aside')
        const queueRect = queue?.getBoundingClientRect()
        const actionRect = action?.getBoundingClientRect()
        const editorRect = editor?.getBoundingClientRect()
        const sendRect = sendButton?.getBoundingClientRect()
        const runtimePanelRect = runtimePanel?.getBoundingClientRect()
        return {
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          queueVisible: Boolean(queue && queueRect?.width),
          queueWithinViewport: Boolean(queueRect && queueRect.left >= 0 && queueRect.right <= window.innerWidth),
          queueFullyVisible: Boolean(queueRect && queueRect.top >= 0 && queueRect.bottom <= window.innerHeight),
          summaryLength: summary?.title.length ?? 0,
          actionWithinViewport: Boolean(actionRect && actionRect.left >= 0 && actionRect.right <= window.innerWidth),
          actionFullyVisible: Boolean(actionRect && actionRect.top >= 0 && actionRect.bottom <= window.innerHeight),
          composerEditorFullyVisible: Boolean(editorRect && editorRect.top >= 0 && editorRect.bottom <= window.innerHeight),
          sendButtonFullyVisible: Boolean(sendRect && sendRect.top >= 0 && sendRect.bottom <= window.innerHeight),
          sendButtonBottom: sendRect?.bottom ?? 0,
          runtimePanelVisible: Boolean(runtimePanelRect && runtimePanelRect.height > 0),
          runtimePanelBottom: runtimePanelRect?.bottom ?? 0,
          queueTop: queueRect?.top ?? 0
        }
      })()`,
      (layout) =>
        Boolean(
          layout?.queueVisible &&
          layout.queueFullyVisible &&
          layout.actionFullyVisible &&
          layout.composerEditorFullyVisible &&
          layout.sendButtonFullyVisible &&
          layout.runtimePanelVisible &&
          layout.runtimePanelBottom <= layout.queueTop
        ),
      'the queue and recovery action to remain visible in a minimum-size window'
    )
    await captureScreenshot(socket, 'queue-minimum-window-after-layout.png')
    expect(narrowQueueLayout.documentWidth).toBeLessThanOrEqual(narrowQueueLayout.viewportWidth)
    expect(narrowQueueLayout.queueWithinViewport).toBe(true)
    expect(narrowQueueLayout.queueFullyVisible).toBe(true)
    expect(narrowQueueLayout.summaryLength).toBeLessThanOrEqual(73)
    expect(narrowQueueLayout.actionWithinViewport).toBe(true)
    expect(narrowQueueLayout.actionFullyVisible).toBe(true)
    expect(narrowQueueLayout.composerEditorFullyVisible).toBe(true)
    expect(narrowQueueLayout.sendButtonFullyVisible).toBe(true)
    expect(narrowQueueLayout.sendButtonBottom).toBeLessThanOrEqual(560)
    expect(narrowQueueLayout.runtimePanelVisible).toBe(true)
    expect(
      narrowQueueLayout.runtimePanelBottom,
      JSON.stringify(narrowQueueLayout)
    ).toBeLessThanOrEqual(narrowQueueLayout.queueTop)
    const screenshotDirectory = process.env.OLA_E2E_SCREENSHOT_DIR
    if (screenshotDirectory) {
      await writeFile(
        join(screenshotDirectory, 'queue-minimum-window-layout.json'),
        JSON.stringify(narrowQueueLayout, null, 2)
      )
    }
    for (const zoom of [1.25, 1.5]) {
      await devToolsCall(socket, 'Emulation.setDeviceMetricsOverride', {
        width: Math.round(760 / zoom),
        height: Math.round(560 / zoom),
        deviceScaleFactor: zoom,
        mobile: false
      })
      const zoomLayout = await waitForExpression<{
        viewportWidth: number
        documentWidth: number
        viewportHeight: number
        queueVisible: boolean
        actionVisible: boolean
        actionBottom: number
        runtimePanelVisible: boolean
        sidebarCollapsed: boolean
        sidebarToggleVisible: boolean
      }>(
        socket,
        `(() => {
          const queue = document.querySelector('.max-h-40.overflow-y-auto')
          const action = Array.from(document.querySelectorAll('button')).find((button) => /^(Retry|重试发送)$/.test(button.getAttribute('aria-label') || button.textContent?.trim() || ''))
          const runtimeHeading = Array.from(document.querySelectorAll('h3')).find((heading) => /环境信息|Environment/.test(heading.textContent || ''))
          const queueRect = queue?.getBoundingClientRect()
          const actionRect = action?.getBoundingClientRect()
          const panelRect = runtimeHeading?.closest('aside')?.getBoundingClientRect()
          return {
            viewportWidth: window.innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            viewportHeight: window.innerHeight,
            queueVisible: Boolean(queueRect && queueRect.width > 0),
            actionVisible: Boolean(actionRect && actionRect.width > 0),
            actionBottom: actionRect?.bottom ?? 0,
            runtimePanelVisible: Boolean(panelRect && panelRect.height > 0),
            sidebarCollapsed: !document.querySelector('.workspace-sidebar-surface'),
            sidebarToggleVisible: Boolean(document.querySelector('.workspace-titlebar-surface button.workspace-titlebar-action'))
          }
        })()`,
        (layout) =>
          Boolean(
            layout?.queueVisible &&
            layout.actionVisible &&
            layout.runtimePanelVisible &&
            layout.sidebarCollapsed &&
            layout.sidebarToggleVisible
          ),
        `the queue, retry action, and runtime panel at ${zoom * 100}% equivalent zoom`
      )
      await captureScreenshot(socket, `queue-zoom-equivalent-${Math.round(zoom * 100)}.png`)
      expect(zoomLayout.documentWidth, JSON.stringify(zoomLayout)).toBeLessThanOrEqual(
        zoomLayout.viewportWidth
      )
      expect(zoomLayout.actionBottom, JSON.stringify(zoomLayout)).toBeLessThanOrEqual(
        zoomLayout.viewportHeight
      )
      expect(zoomLayout.sidebarCollapsed).toBe(true)
      expect(zoomLayout.sidebarToggleVisible).toBe(true)
      if (screenshotDirectory) {
        await writeFile(
          join(screenshotDirectory, `queue-zoom-equivalent-${Math.round(zoom * 100)}.json`),
          JSON.stringify(zoomLayout, null, 2)
        )
      }
    }
    await devToolsCall(socket, 'Emulation.setDeviceMetricsOverride', {
      width: 760,
      height: 560,
      deviceScaleFactor: 1,
      mobile: false
    })
    await devToolsCall(socket, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 8,
      y: 548
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    await captureScreenshot(socket, 'queue-minimum-window.png')
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
      returnByValue: true
    })
    const runtimeStatusEscape = await waitForExpression<{
      panelClosed: boolean
      focusReturned: boolean
    }>(
      socket,
      `({ panelClosed: !document.querySelector('#runtime-status-panel aside'), focusReturned: document.activeElement?.id === 'runtime-status-trigger' })`,
      (result) => Boolean(result?.panelClosed && result.focusReturned),
      'runtime status Escape close and focus return'
    )
    expect(runtimeStatusEscape).toEqual({ panelClosed: true, focusReturned: true })
    if (screenshotDirectory) {
      await writeFile(
        join(screenshotDirectory, 'runtime-status-keyboard-probe.json'),
        JSON.stringify(runtimeStatusEscape, null, 2)
      )
    }
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `document.getElementById('runtime-status-trigger')?.click()`,
      returnByValue: true
    })
    await devToolsCall(socket, 'Emulation.clearDeviceMetricsOverride')

    const registerWorkspace = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('window:workspace:set', { workspaceId: 'local-personal' })`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(registerWorkspace.result?.value).toMatchObject({ workspaceId: 'local-personal' })
    const openSecondaryWindow = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('session-window:open', 'session-queue-secondary-e2e')`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(openSecondaryWindow).toBeDefined()
    const secondaryTarget = await waitForPageMatching(
      port,
      (target) =>
        target.url?.includes('appView=session') === true &&
        target.url.includes('session-queue-secondary-e2e'),
      'the detached secondary session window'
    )
    secondarySocket = new WebSocket(secondaryTarget.webSocketDebuggerUrl!)
    await once(secondarySocket, 'open')
    await devToolsCall(secondarySocket, 'Runtime.enable')
    await devToolsCall(secondarySocket, 'Page.enable')
    const secondaryQueueText = await waitForPageText(
      secondarySocket,
      (text) => text.includes('SECONDARY_WINDOW_QUEUE_SENTINEL'),
      'the secondary session queue in its detached window'
    )
    expect(secondaryQueueText).not.toContain('Interrupted message for review')
    const primaryQueueAfterDetach = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `({ primary: document.body.innerText.includes('Interrupted message for review'), secondary: document.body.innerText.includes('SECONDARY_WINDOW_QUEUE_SENTINEL') })`,
      returnByValue: true
    })
    expect(primaryQueueAfterDetach.result?.value).toEqual({ primary: true, secondary: false })
    await captureScreenshot(secondarySocket, 'secondary-window-queue.png')

    await devToolsCall(socket, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'k',
      code: 'KeyK',
      modifiers: 2,
      windowsVirtualKeyCode: 75,
      nativeVirtualKeyCode: 75
    })
    await devToolsCall(socket, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'k',
      code: 'KeyK',
      modifiers: 2,
      windowsVirtualKeyCode: 75,
      nativeVirtualKeyCode: 75
    })
    const palette = await waitForPageText(
      socket,
      (text) => text.includes('E2E Diagnostics View'),
      'the enabled extension workbench command'
    )
    expect(palette).toContain('E2E Diagnostics View')
    const extensionItem = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `Array.from(document.querySelectorAll('[cmdk-item]')).find((item) => item.textContent?.includes('E2E Diagnostics View'))?.click()`,
      returnByValue: true
    })
    expect(extensionItem).toBeDefined()
    const frameResult = await waitForExpression<{ sandbox?: string | null; srcdoc?: string }>(
      socket,
      `(() => {
        const frame = Array.from(document.querySelectorAll('iframe')).find((item) => item.title === 'E2E Diagnostics View')
        return { sandbox: frame?.getAttribute('sandbox'), srcdoc: frame?.srcdoc }
      })()`,
      (value) => typeof value?.srcdoc === 'string' && value.srcdoc.includes('Safe extension view'),
      'the extension iframe document'
    )
    expect(frameResult.sandbox).toBe('')
    expect(frameResult.srcdoc).toContain("script-src 'none'")
    expect(frameResult.srcdoc).toContain('Safe extension view')
    const parentMutation = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: 'document.documentElement.dataset.e2eExtensionPwned ?? null',
      returnByValue: true
    })
    expect(parentMutation.result?.value).toBeNull()

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await devToolsCall(socket, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27
      })
      await devToolsCall(socket, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27
      })
    }
    await waitForExpression<boolean>(
      socket,
      `!document.querySelector('[cmdk-input]')`,
      Boolean,
      'the command palette to close after selecting the extension view'
    )
    await devToolsCall(socket, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'k',
      code: 'KeyK',
      modifiers: 2,
      windowsVirtualKeyCode: 75,
      nativeVirtualKeyCode: 75
    })
    await devToolsCall(socket, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'k',
      code: 'KeyK',
      modifiers: 2,
      windowsVirtualKeyCode: 75,
      nativeVirtualKeyCode: 75
    })
    await waitForPageText(
      socket,
      (text) => text.includes('E2E Broken Diagnostics View'),
      'the broken extension view command'
    )
    const brokenExtensionItem = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `Array.from(document.querySelectorAll('[cmdk-item]')).find((item) => item.textContent?.includes('E2E Broken Diagnostics View'))?.click()`,
      returnByValue: true
    })
    expect(brokenExtensionItem).toBeDefined()
    await waitForPageText(
      socket,
      (text) =>
        text.includes('Could not load this extension view') || text.includes('无法加载此扩展视图'),
      'a readable extension view loading error'
    )
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await devToolsCall(socket, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27
      })
      await devToolsCall(socket, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27
      })
    }
    await waitForExpression<boolean>(
      socket,
      `!document.querySelector('[cmdk-input]')`,
      Boolean,
      'the command palette to close after dismissing the broken extension view'
    )
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression:
        'window.location.hash = "#/project/project-terminal-e2e/session/session-terminal-e2e"'
    })
    await waitForExpression<boolean>(
      socket,
      `Boolean(document.querySelector('button[aria-label="打开项目终端"], button[aria-label="Open project terminal"]'))`,
      Boolean,
      'the project terminal control in the active code session'
    )
    const workspaceRegistration = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('window:workspace:set', { workspaceId: 'local-personal' })`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(workspaceRegistration.result?.value).toMatchObject({ workspaceId: 'local-personal' })
    const terminalButton = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = document.querySelector('button[aria-label="打开项目终端"], button[aria-label="Open project terminal"]'); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(terminalButton.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `Boolean(document.querySelector('.xterm-helper-textarea'))`,
      Boolean,
      'the live project terminal UI to mount'
    )
    const terminalListExpression = `window.ola.ipc.invokeMessagePack('terminal:list', { workspaceId: 'local-personal' })`
    const terminalEntries = await waitForExpression<Array<{ id: string; cwd?: string }>>(
      socket,
      terminalListExpression,
      (entries) =>
        Array.isArray(entries) &&
        entries.some(
          (entry) =>
            entry.cwd?.replaceAll('\\', '/').toLowerCase() ===
            projectRoot.replaceAll('\\', '/').toLowerCase()
        ),
      'the project terminal session'
    )
    const terminal = terminalEntries.find(
      (entry) =>
        entry.cwd?.replaceAll('\\', '/').toLowerCase() ===
        projectRoot.replaceAll('\\', '/').toLowerCase()
    )
    const testTerminalId = terminal?.id
    expect(testTerminalId).toBeTruthy()
    testTerminalIds.push(testTerminalId!)
    const command =
      'Write-Output OLA_DOCK_BEGIN; Start-Sleep -Seconds 8; Write-Output OLA_DOCK_END\r'
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('terminal:input', { id: ${JSON.stringify(testTerminalId)}, data: ${JSON.stringify(command)} })`,
      awaitPromise: true,
      returnByValue: true
    })
    const outputExpression = `window.ola.ipc.invokeMessagePack('terminal:get', { id: ${JSON.stringify(testTerminalId)} }).then((result) => result?.session?.buffer?.map((chunk) => chunk.data || '').join('') || '')`
    await waitForExpression<string>(
      socket,
      outputExpression,
      (output) => Boolean(output?.includes('OLA_DOCK_BEGIN')),
      'terminal command to start before moving the dock'
    )
    const dockMove = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => item.getAttribute('aria-label') === 'Move terminal to right'); if (!button || button.disabled) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(dockMove.result?.value).toBe(true)
    const rightDockLayout = await waitForExpression<{ area?: string; display?: string }>(
      socket,
      `(() => { const element = document.querySelector('[data-terminal-dock-area]'); return { area: element?.getAttribute('data-terminal-dock-area'), display: element ? getComputedStyle(element).display : undefined } })()`,
      (layout) => layout?.area === 'right' && layout?.display === 'flex',
      'the terminal and conversation to lay out side by side'
    )
    expect(rightDockLayout).toEqual({ area: 'right', display: 'flex' })
    const dockMoveBack = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `Boolean(Array.from(document.querySelectorAll('button')).find((item) => item.getAttribute('aria-label') === 'Move terminal to bottom'))`,
      returnByValue: true
    })
    expect(dockMoveBack.result?.value).toBe(true)
    let persistedDockArea: string | undefined
    let persistedUiStateKeys: string[] = []
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const config = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')) as {
          'ola-ui-state'?: { state?: { terminalDockAreaByProjectId?: Record<string, string> } }
        }
        persistedUiStateKeys = Object.keys(config['ola-ui-state']?.state ?? {})
        persistedDockArea =
          config['ola-ui-state']?.state?.terminalDockAreaByProjectId?.['project-terminal-e2e']
        if (persistedDockArea === 'right') break
      } catch {
        // The app may still be writing the updated persisted UI state.
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const firstDockCache = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('settings:get', 'ola-ui-state').then((value) => value?.state?.terminalDockAreaByProjectId ?? null)`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(
      persistedDockArea,
      `persisted UI state keys=${persistedUiStateKeys.join(', ')}; main cache=${JSON.stringify(firstDockCache.result?.value)}; logs=${childLogs.slice(-2000)}`
    ).toBe('right')
    const stillRunningTerminals = await waitForExpression<
      Array<{ id: string; cwd?: string; exitCode?: number }>
    >(
      socket,
      terminalListExpression,
      (entries) => Array.isArray(entries) && entries.some((entry) => entry.id === testTerminalId),
      'the same terminal session to remain registered after docking'
    )
    expect(
      stillRunningTerminals.find((entry) => entry.id === testTerminalId)?.exitCode
    ).toBeUndefined()
    await waitForExpression<string>(
      socket,
      outputExpression,
      (output) => Boolean(output?.includes('OLA_DOCK_END')),
      'the in-flight terminal command to finish after docking'
    )

    await devToolsCall(socket, 'Runtime.evaluate', {
      expression:
        'window.location.hash = "#/project/project-terminal-second-e2e/session/session-terminal-second-e2e"'
    })
    await waitForExpression<boolean>(
      socket,
      `Boolean(document.querySelector('button[aria-label="打开项目终端"], button[aria-label="Open project terminal"]'))`,
      Boolean,
      'the second project terminal control'
    )
    const secondProjectTerminalButton = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = document.querySelector('button[aria-label="打开项目终端"], button[aria-label="Open project terminal"]'); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(secondProjectTerminalButton.result?.value).toBe(true)
    const secondProjectDefaultDock = await waitForExpression<string | null>(
      socket,
      `document.querySelector('[data-terminal-dock-area]')?.getAttribute('data-terminal-dock-area') ?? null`,
      (area) => area === 'bottom',
      'the second project to keep its independent bottom default'
    )
    expect(secondProjectDefaultDock).toBe('bottom')
    const secondProjectMoveRight = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => item.getAttribute('aria-label') === 'Move terminal to right'); if (!button || button.disabled) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(secondProjectMoveRight.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `document.querySelector('[data-terminal-dock-area="right"]')?.getAttribute('data-terminal-dock-area') === 'right'`,
      Boolean,
      'the second project to move its terminal to the right'
    )
    let projectDockPreferences: { first?: string; second?: string } = {}
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const config = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')) as {
          'ola-ui-state'?: { state?: { terminalDockAreaByProjectId?: Record<string, string> } }
        }
        const preferences = config['ola-ui-state']?.state?.terminalDockAreaByProjectId ?? {}
        projectDockPreferences = {
          first: preferences['project-terminal-e2e'],
          second: preferences['project-terminal-second-e2e']
        }
        if (projectDockPreferences.first === 'right' && projectDockPreferences.second === 'right')
          break
      } catch {
        // Wait for Electron to persist the updated project layout map.
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect(projectDockPreferences).toEqual({ first: 'right', second: 'right' })
    await captureScreenshot(socket, 'second-project-terminal-right.png')
    const secondProjectMoveBottom = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => item.getAttribute('aria-label') === 'Move terminal to bottom'); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(secondProjectMoveBottom.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `document.querySelector('[data-terminal-dock-area="bottom"]')?.getAttribute('data-terminal-dock-area') === 'bottom'`,
      Boolean,
      'the second project to return to its bottom dock preference'
    )
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const config = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')) as {
          'ola-ui-state'?: { state?: { terminalDockAreaByProjectId?: Record<string, string> } }
        }
        const preferences = config['ola-ui-state']?.state?.terminalDockAreaByProjectId ?? {}
        projectDockPreferences = {
          first: preferences['project-terminal-e2e'],
          second: preferences['project-terminal-second-e2e']
        }
        if (projectDockPreferences.first === 'right' && projectDockPreferences.second === 'bottom')
          break
      } catch {
        // Wait for Electron to persist the independent project layout values.
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const persistedDockCache = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('settings:get', 'ola-ui-state').then((value) => value?.state?.terminalDockAreaByProjectId ?? null)`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(
      projectDockPreferences,
      `main cache=${JSON.stringify(persistedDockCache.result?.value)}; logs=${childLogs.slice(-2000)}`
    ).toEqual({ first: 'right', second: 'bottom' })
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression:
        'window.location.hash = "#/project/project-terminal-e2e/session/session-terminal-e2e"'
    })
    await waitForExpression<boolean>(
      socket,
      `document.querySelector('[data-terminal-dock-area="right"]')?.getAttribute('data-terminal-dock-area') === 'right'`,
      Boolean,
      'the first project right dock to remain unchanged after changing the second project'
    )

    await devToolsCall(socket, 'Emulation.setDeviceMetricsOverride', {
      width: 560,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    })
    await waitForExpression<boolean>(
      socket,
      `document.querySelector('[data-terminal-dock-area="bottom"]')?.getAttribute('data-terminal-dock-area') === 'bottom'`,
      Boolean,
      'the terminal dock to fall back to bottom in a narrow window'
    )
    const narrowDockMove = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `Array.from(document.querySelectorAll('button')).find((item) => item.getAttribute('aria-label') === 'Move terminal to right')?.disabled ?? null`,
      returnByValue: true
    })
    expect(narrowDockMove.result?.value).toBe(true)
    await devToolsCall(socket, 'Emulation.clearDeviceMetricsOverride')
    await waitForExpression<boolean>(
      socket,
      `document.querySelector('[data-terminal-dock-area="right"]')?.getAttribute('data-terminal-dock-area') === 'right'`,
      Boolean,
      'the preferred right dock to return after the window expands'
    )

    socket.close()
    socket = undefined
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))])
    child = undefined

    repository = new BusinessRepository({ path: join(root, 'data.db'), mode: 'direct' })
    const persisted = await repository.pendingSessionQueue<{
      id: string
      text: string
      recoveryState?: string
    }>('session-queue-e2e', 'local-personal')
    expect(persisted).toEqual([
      expect.objectContaining({ id: 'interrupted-send', recoveryState: 'needs_review' }),
      expect.objectContaining({ id: 'next-queued-message' }),
      expect.objectContaining({ id: 'long-queued-message' })
    ])
    await repository.close()
    repository = undefined

    const restartPort = 11_000 + Math.floor(Math.random() * 40_000)
    child = spawn(
      packagedExe ?? electronBinary,
      [
        ...(packagedExe ? [] : [join(process.cwd(), 'out/main/index.js')]),
        '--no-sandbox',
        '--disable-gpu',
        `--remote-debugging-port=${restartPort}`,
        `--user-data-dir=${join(root, 'electron-user-data')}`
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, OLA_E2E_DATA_ROOT: root, OLA_STRICT_IPC_ALLOWLIST: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    child.stdout?.on('data', (chunk: Buffer) => {
      childLogs += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      childLogs += chunk.toString()
    })
    const restartedTarget = await waitForPage(restartPort)
    if (!restartedTarget.webSocketDebuggerUrl)
      throw new Error('Restarted Electron renderer has no DevTools URL')
    socket = new WebSocket(restartedTarget.webSocketDebuggerUrl)
    await once(socket, 'open')
    await devToolsCall(socket, 'Runtime.enable')
    await devToolsCall(socket, 'Page.enable')
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    const restartedTaskDb = new DatabaseSync(join(root, 'data.db'), { readOnly: true })
    expect(
      (
        restartedTaskDb.prepare("SELECT subject FROM tasks WHERE id='business-task-e2e'").get() as {
          subject: string
        }
      ).subject
    ).toBe('Linked run entry E2E task edited')
    expect(
      (
        restartedTaskDb
          .prepare("SELECT COUNT(*) AS count FROM tasks WHERE subject='E2E persisted created task'")
          .get() as { count: number }
      ).count
    ).toBe(1)
    expect(
      (
        restartedTaskDb
          .prepare('SELECT COUNT(*) AS count FROM tasks WHERE id = ?')
          .get(createdTaskRow!.id) as { count: number }
      ).count
    ).toBe(0)
    restartedTaskDb.close()
    const restartedDateDb = new DatabaseSync(join(root, 'data.db'), { readOnly: true })
    const restartedMetadata = JSON.parse(
      (
        restartedDateDb
          .prepare("SELECT metadata FROM tasks WHERE id='business-task-e2e'")
          .get() as {
          metadata: string
        }
      ).metadata
    ) as { board?: { dueDate?: string } }
    expect(restartedMetadata.board?.dueDate).toBe('2026-10-04')
    restartedDateDb.close()
    await waitForExpression<boolean>(
      socket,
      `(() => { const tab = document.querySelector('[data-workspace-id="local-personal"]'); if (!tab) return false; if (tab.getAttribute('aria-selected') !== 'true') tab.click(); return tab.getAttribute('aria-selected') === 'true' })()`,
      Boolean,
      'the personal workspace to be active after restarting Electron'
    )
    await waitForPageText(
      socket,
      (text) => text.includes('Terminal dock e2e session'),
      'the personal workspace project session after restarting Electron'
    )
    const revealTasksNavigation = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const taskButton = [...document.querySelectorAll('button')].find((item) => ['Tasks', '任务', 'Tasks & automation', '任务与自动化'].includes(item.getAttribute('aria-label') ?? item.textContent?.trim() ?? '')); if (taskButton) return true; const toggle = document.querySelector('.workspace-titlebar-surface button.workspace-titlebar-action'); if (!toggle) return false; toggle.click(); return true })()`,
      returnByValue: true
    })
    expect(revealTasksNavigation.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `Boolean([...document.querySelectorAll('button')].find((item) => ['Tasks', '任务', 'Tasks & automation', '任务与自动化'].includes(item.getAttribute('aria-label') ?? item.textContent?.trim() ?? '')))`,
      Boolean,
      'the tasks navigation after revealing the sidebar'
    )
    const reopenTasksAfterRestart = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = [...document.querySelectorAll('button')].find((item) => ['Tasks', '任务', 'Tasks & automation', '任务与自动化'].includes(item.getAttribute('aria-label') ?? item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(reopenTasksAfterRestart.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `Boolean([...document.querySelectorAll('button')].find((item) => ['Board', '看板', '任务看板'].includes(item.textContent?.trim() ?? '')))`,
      Boolean,
      'the board entry after restarting Electron'
    )
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `([...document.querySelectorAll('button')].find((item) => ['Board', '看板', '任务看板'].includes(item.textContent?.trim() ?? '')))?.click()`
    })
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `([...document.querySelectorAll('button')].find((item) => ['List', '列表'].includes(item.textContent?.trim() ?? '')))?.click()`
    })
    await waitForPageText(
      socket,
      (text) => text.includes('E2E persisted created task'),
      'the created task to remain visible after restarting Electron'
    )
    await waitForExpression<boolean>(
      socket,
      `!document.body.innerText.includes('E2E created task')`,
      Boolean,
      'the deleted task to remain absent after restarting Electron'
    )
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression:
        'window.location.hash = "#/project/project-terminal-e2e/session/session-terminal-e2e"'
    })
    await waitForExpression<boolean>(
      socket,
      `document.querySelector('[data-terminal-dock-area="right"]')?.getAttribute('data-terminal-dock-area') === 'right'`,
      Boolean,
      'the right terminal dock preference to restore after restarting Electron'
    )
    await waitForExpression<boolean>(
      socket,
      `Boolean(document.querySelector('[data-terminal-dock-area="right"] [data-project-terminal-dock][data-project-id="project-terminal-e2e"] .workspace-terminal-tab'))`,
      Boolean,
      'the persisted open terminal dock to restore after restarting Electron'
    )
    const openProjectResults = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: 'window.location.hash = "#/project/project-terminal-e2e"; true',
      returnByValue: true
    })
    expect(openProjectResults.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `(() => { const button = Array.from(document.querySelectorAll('nav[aria-label="Project navigation"] button, nav[aria-label="项目导航"] button')).find((item) => ['Results', '结果'].includes(item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      Boolean,
      'the project results tab to open after restarting Electron'
    )
    await waitForPageText(
      socket,
      (text) => text.includes('e2e-confirmed-result.md'),
      'the project result to remain searchable after restarting Electron'
    )
    await waitForExpression<boolean>(
      socket,
      `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => ['Use in next task', '用作下一次输入'].includes(item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      Boolean,
      'the confirmed result to be reusable as the next input'
    )
    await waitForExpression<boolean>(
      socket,
      `Boolean(document.querySelector('.composer-editor-content [data-file-ref]'))`,
      Boolean,
      'the reused result file reference to appear in the source session composer'
    )
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: 'window.location.hash = "#/project/project-terminal-e2e"'
    })
    await waitForExpression<boolean>(
      socket,
      `(() => { const button = Array.from(document.querySelectorAll('nav[aria-label="Project navigation"] button, nav[aria-label="项目导航"] button')).find((item) => ['Results', '结果'].includes(item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      Boolean,
      'the project results tab to reopen before removing the index entry'
    )
    await waitForPageText(
      socket,
      (text) => text.includes('e2e-confirmed-result.md'),
      'the confirmed result before removal'
    )
    await waitForExpression<boolean>(
      socket,
      `(() => { const button = Array.from(document.querySelectorAll('button')).find((item) => ['Remove from results', '从结果中移除'].includes(item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      Boolean,
      'the remove-index confirmation to open'
    )
    await waitForExpression<boolean>(
      socket,
      `(() => { const button = document.querySelector('[data-slot="alert-dialog-action"]'); if (!button) return false; button.click(); return true })()`,
      Boolean,
      'the result-index removal to be confirmed'
    )
    await waitForPageText(
      socket,
      (text) =>
        text.includes('No confirmed results match this view') ||
        text.includes('当前没有符合条件的已确认结果'),
      'the removed result to disappear from the project index'
    )
    expect(await readFile(resultPath, 'utf8')).toBe('# Confirmed result\n')
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression:
        'window.location.hash = "#/project/project-terminal-second-e2e/session/session-terminal-second-e2e"'
    })
    await waitForExpression<boolean>(
      socket,
      `document.querySelector('[data-terminal-dock-area="bottom"]')?.getAttribute('data-terminal-dock-area') === 'bottom'`,
      Boolean,
      'the second project bottom preference to persist independently after restart'
    )
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: 'window.location.hash = "#/chat/session-delete-failure-e2e"'
    })
    await waitForPageText(
      socket,
      (text) => text.includes('Delete failure recovery session'),
      'the session selected for delete failure recovery'
    )
    const activateDeleteSession = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('Delete failure recovery session')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(activateDeleteSession.result?.value).toBe(true)
    const openDeletePalette = async (): Promise<void> => {
      await devToolsCall(socket!, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'k',
        code: 'KeyK',
        modifiers: 2
      })
      await devToolsCall(socket!, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'k',
        code: 'KeyK',
        modifiers: 2
      })
      await waitForExpression<boolean>(
        socket!,
        `Boolean(document.querySelector('[cmdk-input]'))`,
        Boolean,
        'the command palette for session deletion'
      )
      const focusCommandInput = await devToolsCall(socket!, 'Runtime.evaluate', {
        expression: `(() => { const input = document.querySelector('[cmdk-input]'); if (!(input instanceof HTMLInputElement)) return false; input.focus(); return document.activeElement === input })()`,
        returnByValue: true
      })
      expect(focusCommandInput.result?.value).toBe(true)
      await devToolsCall(socket!, 'Input.insertText', { text: 'delete' })
      await waitForExpression<boolean>(
        socket!,
        `Boolean([...document.querySelectorAll('[cmdk-item]')].find((item) => item.textContent?.includes('删除当前会话')))`,
        Boolean,
        'the delete current session action'
      )
      const clickDeleteAction = await devToolsCall(socket!, 'Runtime.evaluate', {
        expression: `(() => { const item = [...document.querySelectorAll('[cmdk-item]')].find((entry) => entry.textContent?.includes('删除当前会话')); if (!item) return false; item.click(); return true })()`,
        returnByValue: true
      })
      expect(clickDeleteAction.result?.value).toBe(true)
    }
    await openDeletePalette()
    await waitForPageText(
      socket,
      (text) => text.includes('删除会话失败，请重试。'),
      'the localized database delete failure feedback'
    )
    const sessionRetainedAfterDeleteFailure = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('db:sessions:list:msgpack', { workspaceId: 'local-personal' }).then((sessions) => sessions.some((session) => session.id === 'session-delete-failure-e2e'))`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(sessionRetainedAfterDeleteFailure.result?.value).toBe(true)
    const dropDeleteFailureTrigger = new DatabaseSync(join(root, 'data.db'))
    dropDeleteFailureTrigger.exec('DROP TRIGGER reject_session_delete')
    dropDeleteFailureTrigger.close()
    await openDeletePalette()
    const sessionDeletedAfterRetry = await waitForExpression<boolean>(
      socket,
      `window.ola.ipc.invokeMessagePack('db:sessions:list:msgpack', { workspaceId: 'local-personal' }).then((sessions) => !sessions.some((session) => session.id === 'session-delete-failure-e2e'))`,
      Boolean,
      'the session to be removed after a successful database retry'
    )
    expect(sessionDeletedAfterRetry).toBe(true)

    const dynamicSkillDirectory = join(root, '.agents', 'skills', 'e2e-dynamic-skill')
    await mkdir(dynamicSkillDirectory, { recursive: true })
    await writeFile(
      join(dynamicSkillDirectory, 'SKILL.md'),
      '---\nname: e2e-dynamic-skill\ndescription: Verify a newly installed skill appears in the next model request.\n---\n\n# E2E dynamic skill\nUse this skill only for the isolated Electron fixture.\n',
      'utf8'
    )
    const dynamicAgentPath = join(root, 'agents', 'e2e-dynamic-agent.md')
    await mkdir(join(root, 'agents'), { recursive: true })
    await writeFile(
      dynamicAgentPath,
      '---\nname: e2e-dynamic-agent\ndescription: Verify a newly installed SubAgent appears in the next model request.\nprofiles: [code]\ntools: [Read]\n---\n\nOnly inspect the isolated E2E fixture.\n',
      'utf8'
    )

    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: 'window.location.hash = "#/"'
    })
    await waitForExpression<boolean>(
      socket,
      `Boolean(document.querySelector('[data-testid="first-success-template-materials-report"]'))`,
      Boolean,
      'the report scenario template after completing workspace and session checks'
    )
    const openFinalMaterialsTemplate = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const card = document.querySelector('[data-testid="first-success-template-materials-report"]'); if (!card) return false; card.click(); return true })()`,
      returnByValue: true
    })
    expect(openFinalMaterialsTemplate.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `Boolean(document.querySelector('[data-testid="first-success-template-dialog"]'))`,
      Boolean,
      'the final report scenario configuration dialog'
    )
    const fillFinalScenarioFields = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const setValue = (selector, value) => { const field = document.querySelector(selector); if (!(field instanceof HTMLTextAreaElement)) return false; const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; setter?.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); return true }; return setValue('[data-testid="first-success-template-materials"]', 'Release notes: version 2 adds audit logging and fixes an upload timeout.') && setValue('[data-testid="first-success-template-scope"]', 'Summarize the release impact and list unresolved rollout risks.') })()`,
      returnByValue: true
    })
    expect(fillFinalScenarioFields.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `document.querySelector('[data-testid="first-success-template-use-prompt"]')?.disabled === false`,
      Boolean,
      'the final report scenario preflight to pass'
    )
    const prepareFinalScenario = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = document.querySelector('[data-testid="first-success-template-use-prompt"]'); if (!button || button.disabled) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(prepareFinalScenario.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `(() => { const editor = document.querySelector('[role="textbox"][contenteditable="true"]'); const textArea = [...document.querySelectorAll('textarea')].find((field) => field.value.includes('Release notes: version 2 adds audit logging')); return !document.querySelector('[data-testid="first-success-template-dialog"]') && Boolean(textArea?.value.includes('Release notes: version 2 adds audit logging') || editor?.textContent?.includes('Release notes: version 2 adds audit logging')) })()`,
      Boolean,
      'the report prompt in the composer before final execution'
    )
    const sendFinalScenario = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = document.querySelector('[data-tour="composer"] .composer-send'); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(sendFinalScenario.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `Boolean([...document.querySelectorAll('button')].find((button) => button.textContent?.includes('切换并继续')))`,
      Boolean,
      'the final scenario execution-mode confirmation'
    )
    const confirmFinalScenario = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('切换并继续')); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(confirmFinalScenario.result?.value).toBe(true)
    for (let attempt = 0; attempt < 40 && !modelRequestBody; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect(modelRequestBody).toContain(
      'Release notes: version 2 adds audit logging and fixes an upload timeout.'
    )
    await waitForPageText(
      socket,
      (text) => text.includes('E2E report generated from supplied release notes.'),
      'the real runtime response for the report scenario template'
    )

    const requestsBeforeDynamicSkill = modelRequestBodies.length
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression:
        'window.location.hash = "#/project/project-terminal-second-e2e/session/session-terminal-second-e2e"'
    })
    await waitForExpression<boolean>(
      socket,
      `Boolean(document.querySelector('[role="textbox"][contenteditable="true"]'))`,
      Boolean,
      'the code session composer for the dynamic Skill request'
    )
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `document.querySelector('[role="textbox"][contenteditable="true"]')?.focus()`
    })
    await devToolsCall(socket, 'Input.insertText', {
      text: 'Reply briefly to verify the newly installed skill is in this request.'
    })
    await waitForExpression<boolean>(
      socket,
      `document.querySelector('[role="textbox"][contenteditable="true"]')?.textContent?.includes('newly installed skill') === true`,
      Boolean,
      'the dynamic Skill prompt in the code session composer'
    )
    const sendDynamicSkillRequest = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = document.querySelector('[data-tour="composer"] .composer-send'); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(sendDynamicSkillRequest.result?.value).toBe(true)
    for (
      let attempt = 0;
      attempt < 80 && modelRequestBodies.length === requestsBeforeDynamicSkill;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect(modelRequestBodies.length).toBeGreaterThan(requestsBeforeDynamicSkill)
    const dynamicModelRequest = JSON.parse(modelRequestBodies.at(-1)!) as {
      tools?: Array<{
        function?: {
          name?: string
          parameters?: {
            properties?: {
              SkillName?: { enum?: string[] }
              subagent_type?: { enum?: string[] }
            }
          }
        }
      }>
    }
    const skillDefinition = dynamicModelRequest.tools?.find(
      (tool) => tool.function?.name === 'Skill'
    )
    expect(skillDefinition?.function?.parameters?.properties?.SkillName?.enum).toContain(
      'e2e-dynamic-skill'
    )
    const dynamicTaskDefinition = dynamicModelRequest.tools?.find(
      (tool) => tool.function?.name === 'Task'
    )
    expect(dynamicTaskDefinition?.function?.parameters?.properties?.subagent_type?.enum).toContain(
      'e2e-dynamic-agent'
    )
    expect(dynamicModelRequest.tools?.map((tool) => tool.function?.name)).toContain(
      'extension__e2e-view__fixture'
    )
    await waitForPageText(
      socket,
      (text) => text.includes('E2E report generated from supplied release notes.'),
      'the code session response after adding a Skill'
    )
    await rm(join(dynamicSkillDirectory, 'SKILL.md'))
    await rm(dynamicAgentPath)
    const requestsBeforeSkillRemoval = modelRequestBodies.length
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `document.querySelector('[role="textbox"][contenteditable="true"]')?.focus()`
    })
    await devToolsCall(socket, 'Input.insertText', {
      text: 'Reply briefly after removing the temporary skill.'
    })
    await waitForExpression<boolean>(
      socket,
      `document.querySelector('[role="textbox"][contenteditable="true"]')?.textContent?.includes('removing the temporary skill') === true`,
      Boolean,
      'the prompt after removing the dynamic Skill'
    )
    const sendAfterSkillRemoval = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = document.querySelector('[data-tour="composer"] .composer-send'); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(sendAfterSkillRemoval.result?.value).toBe(true)
    for (
      let attempt = 0;
      attempt < 80 && modelRequestBodies.length === requestsBeforeSkillRemoval;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect(modelRequestBodies.length).toBeGreaterThan(requestsBeforeSkillRemoval)
    const requestAfterSkillRemoval = JSON.parse(modelRequestBodies.at(-1)!) as {
      tools?: Array<{
        function?: {
          name?: string
          parameters?: {
            properties?: {
              SkillName?: { enum?: string[] }
              subagent_type?: { enum?: string[] }
            }
          }
        }
      }>
    }
    const skillAfterRemoval = requestAfterSkillRemoval.tools?.find(
      (tool) => tool.function?.name === 'Skill'
    )
    expect(skillAfterRemoval?.function?.parameters?.properties?.SkillName?.enum).not.toContain(
      'e2e-dynamic-skill'
    )
    const taskAfterRemoval = requestAfterSkillRemoval.tools?.find(
      (tool) => tool.function?.name === 'Task'
    )
    expect(taskAfterRemoval?.function?.parameters?.properties?.subagent_type?.enum).not.toContain(
      'e2e-dynamic-agent'
    )
    expect(requestAfterSkillRemoval.tools?.map((tool) => tool.function?.name)).toContain(
      'extension__e2e-view__fixture'
    )
    await waitForExpression<boolean>(
      socket,
      `document.body.innerText.split('E2E report generated from supplied release notes.').length >= 3`,
      Boolean,
      'the second code session response after removing the Skill and SubAgent'
    )
    const extensionArtifactsExpression = `window.ola.ipc.invokeMessagePack('execution-artifacts:list:msgpack', { workspaceId: 'local-personal', projectId: 'project-terminal-second-e2e', category: 'link' }).then((result) => result.artifacts)`
    for (const [marker, expectedUrl] of [
      ['E2E_EXTENSION_REPORT_OK', 'https://reports.example.test/e2e-ok'],
      ['E2E_EXTENSION_REPORT_FAIL', 'https://reports.example.test/e2e-failed']
    ] as const) {
      const requestsBeforeReport = modelRequestBodies.length
      await devToolsCall(socket, 'Runtime.evaluate', {
        expression: `document.querySelector('[role="textbox"][contenteditable="true"]')?.focus()`
      })
      await devToolsCall(socket, 'Input.insertText', { text: marker })
      await waitForExpression<boolean>(
        socket,
        `document.querySelector('[role="textbox"][contenteditable="true"]')?.textContent?.includes(${JSON.stringify(marker)}) === true`,
        Boolean,
        `the ${marker} prompt in the code session composer`
      )
      const sendReport = await devToolsCall(socket, 'Runtime.evaluate', {
        expression: `(() => { const button = document.querySelector('[data-tour="composer"] .composer-send'); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true })()`,
        returnByValue: true
      })
      expect(sendReport.result?.value).toBe(true)
      for (
        let attempt = 0;
        attempt < 80 && modelRequestBodies.length < requestsBeforeReport + 2;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      expect(modelRequestBodies.length).toBeGreaterThanOrEqual(requestsBeforeReport + 2)
      if (marker === 'E2E_EXTENSION_REPORT_OK') {
        const artifacts = await waitForExpression<Array<{ url?: string }>>(
          socket,
          extensionArtifactsExpression,
          (items) => Array.isArray(items) && items.some((item) => item.url === expectedUrl),
          'the successful Extension link in the project results index'
        )
        expect(artifacts.some((item) => item.url === expectedUrl)).toBe(true)
      } else {
        const artifacts = await waitForExpression<Array<{ url?: string }>>(
          socket,
          extensionArtifactsExpression,
          Array.isArray,
          'the results index after the failed Extension call'
        )
        expect(artifacts.some((item) => item.url === expectedUrl)).toBe(false)
      }
    }
    const openTasksForExtensionResult = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = [...document.querySelectorAll('button')].find((item) => ['Tasks', '任务', 'Tasks & automation', '任务与自动化'].includes(item.getAttribute('aria-label') ?? item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(openTasksForExtensionResult.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `Boolean([...document.querySelectorAll('button')].find((item) => ['结果', 'Results'].includes(item.textContent?.trim() ?? '')))`,
      Boolean,
      'the task page results entry'
    )
    const openExtensionResults = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = [...document.querySelectorAll('button')].find((item) => ['结果', 'Results'].includes(item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(openExtensionResults.result?.value).toBe(true)
    const visibleExtensionResult = await waitForPageText(
      socket,
      (body) => body.includes('E2E extension report'),
      'the successful Extension link in the visible results page'
    )
    expect(visibleExtensionResult).not.toContain('Failed extension report')
    const returnFromExtensionResults = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = [...document.querySelectorAll('button')].find((item) => ['打开来源会话', 'Open source session'].includes(item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(returnFromExtensionResults.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `Boolean(document.querySelector('[role="textbox"][contenteditable="true"]'))`,
      Boolean,
      'the code session composer after checking Extension results'
    )
    const disableExtension = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `window.ola.ipc.invokeMessagePack('extension:update:msgpack', { id: 'e2e-view', patch: { enabled: false } })`,
      awaitPromise: true,
      returnByValue: true
    })
    expect(disableExtension.result?.value).toEqual({ success: true })
    const requestsBeforeExtensionDisable = modelRequestBodies.length
    await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `document.querySelector('[role="textbox"][contenteditable="true"]')?.focus()`
    })
    await devToolsCall(socket, 'Input.insertText', {
      text: 'Reply briefly after disabling the temporary extension.'
    })
    await waitForExpression<boolean>(
      socket,
      `document.querySelector('[role="textbox"][contenteditable="true"]')?.textContent?.includes('disabling the temporary extension') === true`,
      Boolean,
      'the prompt after disabling the Extension'
    )
    const sendAfterExtensionDisable = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = document.querySelector('[data-tour="composer"] .composer-send'); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(sendAfterExtensionDisable.result?.value).toBe(true)
    for (
      let attempt = 0;
      attempt < 80 && modelRequestBodies.length === requestsBeforeExtensionDisable;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect(modelRequestBodies.length).toBeGreaterThan(requestsBeforeExtensionDisable)
    const requestAfterExtensionDisable = JSON.parse(modelRequestBodies.at(-1)!) as {
      tools?: Array<{ function?: { name?: string } }>
    }
    expect(requestAfterExtensionDisable.tools?.map((tool) => tool.function?.name)).not.toContain(
      'extension__e2e-view__fixture'
    )
    expect(
      modelRequestBodies.some((body) => body.includes('Create the final user-facing outcome'))
    ).toBe(true)
    expect(childLogs).not.toContain('SESSION_WORKSPACE_MISMATCH')
    expect(childLogs).not.toContain(
      "Error invoking remote method 'memory-automation:record:msgpack': Error: db-workspace-required"
    )
    expect(childLogs).not.toContain('RuntimeError: BUSINESS_UPDATE_EMPTY')
    expect(
      childLogs.split("Error occurred in handler for 'db:tasks:list-all:msgpack'").length - 1
    ).toBe(1)
    expect(childLogs.split('[TaskBoardStore] Failed to load task projection:').length - 1).toBe(1)

    socket.close()
    socket = undefined
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))])
    child = undefined

    const artifactRestartPort = 11_000 + Math.floor(Math.random() * 40_000)
    child = spawn(
      packagedExe ?? electronBinary,
      [
        ...(packagedExe ? [] : [join(process.cwd(), 'out/main/index.js')]),
        '--no-sandbox',
        '--disable-gpu',
        `--remote-debugging-port=${artifactRestartPort}`,
        `--user-data-dir=${join(root, 'electron-user-data')}`
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, OLA_E2E_DATA_ROOT: root, OLA_STRICT_IPC_ALLOWLIST: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    child.stdout?.on('data', (chunk: Buffer) => {
      childLogs += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      childLogs += chunk.toString()
    })
    const artifactRestartTarget = await waitForPage(artifactRestartPort)
    if (!artifactRestartTarget.webSocketDebuggerUrl)
      throw new Error('Artifact restart Electron renderer has no DevTools URL')
    socket = new WebSocket(artifactRestartTarget.webSocketDebuggerUrl)
    await once(socket, 'open')
    await devToolsCall(socket, 'Runtime.enable')
    await devToolsCall(socket, 'Page.enable')
    await waitForExpression<boolean>(
      socket,
      `(() => { const tab = document.querySelector('[data-workspace-id="local-personal"]'); if (!tab) return false; if (tab.getAttribute('aria-selected') !== 'true') tab.click(); return tab.getAttribute('aria-selected') === 'true' })()`,
      Boolean,
      'the personal workspace after restarting the Extension result flow'
    )
    const restartedExtensionArtifacts = await waitForExpression<Array<{ url?: string }>>(
      socket,
      extensionArtifactsExpression,
      (items) =>
        Array.isArray(items) &&
        items.some((item) => item.url === 'https://reports.example.test/e2e-ok'),
      'the Extension result index after restarting Electron'
    )
    expect(
      restartedExtensionArtifacts.some(
        (item) => item.url === 'https://reports.example.test/e2e-failed'
      )
    ).toBe(false)
    const revealTasksAfterArtifactRestart = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const taskButton = [...document.querySelectorAll('button')].find((item) => ['Tasks', '任务', 'Tasks & automation', '任务与自动化'].includes(item.getAttribute('aria-label') ?? item.textContent?.trim() ?? '')); if (taskButton) return true; const toggle = document.querySelector('.workspace-titlebar-surface button.workspace-titlebar-action'); if (!toggle) return false; toggle.click(); return true })()`,
      returnByValue: true
    })
    expect(revealTasksAfterArtifactRestart.result?.value).toBe(true)
    const openTasksAfterArtifactRestart = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = [...document.querySelectorAll('button')].find((item) => ['Tasks', '任务', 'Tasks & automation', '任务与自动化'].includes(item.getAttribute('aria-label') ?? item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(openTasksAfterArtifactRestart.result?.value).toBe(true)
    await waitForExpression<boolean>(
      socket,
      `Boolean([...document.querySelectorAll('button')].find((item) => ['结果', 'Results'].includes(item.textContent?.trim() ?? '')))`,
      Boolean,
      'the results entry after restarting Electron'
    )
    const openResultsAfterArtifactRestart = await devToolsCall(socket, 'Runtime.evaluate', {
      expression: `(() => { const button = [...document.querySelectorAll('button')].find((item) => ['结果', 'Results'].includes(item.textContent?.trim() ?? '')); if (!button) return false; button.click(); return true })()`,
      returnByValue: true
    })
    expect(openResultsAfterArtifactRestart.result?.value).toBe(true)
    const visibleAfterArtifactRestart = await waitForPageText(
      socket,
      (body) => body.includes('E2E extension report'),
      'the Extension result in the visible results page after restarting Electron'
    )
    expect(visibleAfterArtifactRestart).not.toContain('Failed extension report')
  }, 180_000)
})
