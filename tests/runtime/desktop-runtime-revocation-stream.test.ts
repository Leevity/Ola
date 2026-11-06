import { expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ baseUrl: '', dataDirectory: '' }))

vi.mock('../../src/main/lib/ola-data-root', () => ({
  olaDataRoot: () => state.dataDirectory,
  olaExternalDataHome: () => state.dataDirectory
}))

vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: async () => new Set(['team-a']),
  loadOfflineWorkspaceExpiresAt: async () => null,
  loadManagedWorkspaceIds: async () => new Set(),
  loadManagedModelResources: async () => []
}))

vi.mock('../../src/main/providers/provider-main-store', () => ({
  resolveMainProviderModel: () => ({
    provider: {
      id: 'provider',
      type: 'openai-chat',
      apiKey: 'test-key',
      baseUrl: state.baseUrl,
      enabled: true,
      models: [{ id: 'model', enabled: true }]
    },
    model: { id: 'model', enabled: true }
  }),
  resolveMainProviderSecret: async (_providerId: string, fallback?: string) => fallback ?? ''
}))

import { DesktopRuntime } from '../../src/main/runtime/desktop-runtime'
import { closeBusinessWriteCanary } from '../../src/main/db/business-write-canary'
import { notifyWorkspaceDirectoryChanged } from '../../src/main/remote/account-lifecycle'
import type { RunEvent } from '../../src/shared/runtime/contracts'

it('aborts an in-flight desktop model stream when its team workspace is revoked', async () => {
  let requests = 0
  let responseClosed = false
  const model = createServer((_request, response) => {
    requests++
    response.on('close', () => {
      responseClosed = true
    })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.flushHeaders()
  })
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ola-revoked-model-stream-'))
  state.dataDirectory = dataDirectory
  const runtime = new DesktopRuntime(join(dataDirectory, 'desktop-runtime.json'))
  try {
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    const address = model.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP model listener')
    state.baseUrl = `http://127.0.0.1:${address.port}/v1`
    await runtime.start(dataDirectory)
    await runtime.request('run.submit', {
      runId: 'team-stream',
      taskId: 'task',
      requestId: 'request',
      traceId: 'trace',
      sessionId: 'session',
      workspaceId: 'team-a',
      environmentId: 'local',
      modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
      prompt: 'hello',
      unattended: true
    })
    await expect.poll(() => requests).toBe(1)
    await notifyWorkspaceDirectoryChanged(new Set())
    await expect
      .poll(
        async () =>
          (
            await runtime.request<{ run: { status: string } }>('run.snapshot', {
              workspaceId: 'team-a',
              runId: 'team-stream'
            })
          ).run.status
      )
      .toBe('cancelled')
    await expect.poll(() => responseClosed).toBe(true)
  } finally {
    await runtime.stop()
    await closeBusinessWriteCanary()
    model.closeAllConnections()
    await new Promise<void>((resolve) => model.close(() => resolve()))
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

// The offline directory never names the local personal workspace, so a re-read that is not
// rejoined with it revokes every personal run's push and the UI never learns the terminal state.
it('keeps a personal run stream subscribed when the offline workspace directory is re-read', async () => {
  let writeChunk: ((payload: unknown) => void) | null = null
  let endResponse: (() => void) | null = null
  const model = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.flushHeaders()
    writeChunk = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`)
    endResponse = () => {
      response.write('data: [DONE]\n\n')
      response.end()
    }
  })
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ola-personal-revoke-'))
  state.dataDirectory = dataDirectory
  const runtime = new DesktopRuntime(join(dataDirectory, 'desktop-runtime.json'))
  const pushed: RunEvent[] = []
  const resyncReasons: string[] = []
  try {
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    const address = model.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP model listener')
    state.baseUrl = `http://127.0.0.1:${address.port}/v1`
    await runtime.start(dataDirectory)
    await runtime.request('run.submit', {
      runId: 'personal-stream',
      taskId: 'task',
      requestId: 'request',
      traceId: 'trace',
      sessionId: 'session',
      workspaceId: 'local-personal',
      environmentId: 'local',
      modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
      prompt: 'hello',
      unattended: true
    })
    await expect.poll(() => (writeChunk ? true : false)).toBe(true)
    const stream = await runtime.openRunStream({
      workspaceId: 'local-personal',
      runId: 'personal-stream',
      afterSeq: 0,
      onEvent: (event) => pushed.push(event),
      onResync: (reason) => resyncReasons.push(reason)
    })
    writeChunk!({ choices: [{ delta: { content: 'before' } }] })
    await expect
      .poll(() => pushed.some((event) => JSON.stringify(event.data) === '{"text":"before"}'))
      .toBe(true)
    const beforeDirectoryRead = pushed.length
    await notifyWorkspaceDirectoryChanged(new Set(['team-a']))
    writeChunk!({ choices: [{ delta: { content: 'after' }, finish_reason: 'stop' }] })
    endResponse!()
    await expect
      .poll(
        () =>
          pushed.length > beforeDirectoryRead &&
          pushed.some((event) => JSON.stringify(event.data)?.includes('after')),
        {
          timeout: 10_000
        }
      )
      .toBe(true)
    expect(resyncReasons).toEqual([])
    await expect
      .poll(
        async () =>
          (
            await runtime.request<{ run: { status: string } }>('run.snapshot', {
              workspaceId: 'local-personal',
              runId: 'personal-stream'
            })
          ).run.status
      )
      .toBe('completed')
    await stream.close()
  } finally {
    await runtime.stop()
    await closeBusinessWriteCanary()
    model.closeAllConnections()
    await new Promise<void>((resolve) => model.close(() => resolve()))
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
