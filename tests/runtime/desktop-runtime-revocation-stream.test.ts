import { expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ baseUrl: '' }))

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
import { notifyWorkspaceDirectoryChanged } from '../../src/main/remote/account-lifecycle'

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
    model.closeAllConnections()
    await new Promise<void>((resolve) => model.close(() => resolve()))
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
