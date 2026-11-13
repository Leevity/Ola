import { describe, expect, it, vi } from 'vitest'
import { execFile, fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const mocks = vi.hoisted(() => ({ children: [] as ChildProcess[], crashOnReady: false }))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  utilityProcess: {
    fork: (entry: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      // Vitest runs the unbundled source, so the supervisor's module-relative
      // entry URL points into src/. The crash test needs the real built child.
      const childEntry = existsSync(entry) ? entry : resolve('out/runtime/isolated.mjs')
      const child = fork(resolve('tests/fixtures/isolated-runtime-child.mjs'), [childEntry], {
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      })
      mocks.children.push(child)
      child.on('message', (message) => {
        if (mocks.crashOnReady && (message as { type?: string })?.type === 'ready')
          child.kill('SIGKILL')
      })
      // The supervisor speaks utilityProcess's port API; a Node fork calls it send().
      return Object.assign(child, { postMessage: (value: { type: string }) => child.send(value) })
    }
  }
}))

import { createRuntimeHostBridge } from '../../src/main/runtime/runtime-host-bridge'
import {
  isolatedRuntimeSupported,
  startIsolatedRuntimeService
} from '../../src/main/runtime/isolated-runtime-service'
import { RuntimeClient } from '../../src/runtime/host/runtime-client'
import { ToolExecutor } from '../../src/runtime/tools/tool-executor'
import type { ProviderAdapter } from '../../src/shared/runtime/model'
import {
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION,
  type RunSnapshot
} from '../../src/shared/runtime/contracts'

const exec = promisify(execFile)

function spec(runId: string): Record<string, unknown> {
  return {
    runId,
    taskId: `task-${runId}`,
    requestId: `request-${runId}`,
    traceId: `trace-${runId}`,
    sessionId: `session-${runId}`,
    workspaceId: 'local-personal',
    environmentId: 'local',
    modelSource: { kind: 'local', providerId: 'p', modelId: 'm' },
    prompt: 'go',
    unattended: true
  }
}

async function setup(provider: ProviderAdapter) {
  const directory = await mkdtemp(join(tmpdir(), 'ola-isolated-crash-'))
  const client = new RuntimeClient()
  const events = { disconnected: 0, restarted: 0, unavailable: '' }
  const bridge = createRuntimeHostBridge({
    client,
    authorize: async () => undefined,
    provider,
    tools: async () => new ToolExecutor([], async () => true),
    workspaceIds: async () => new Set(['local-personal'])
  })
  client.onRequest(bridge.handle)
  const service = await startIsolatedRuntimeService({
    dataDirectory: directory,
    client,
    capabilities: RUNTIME_CAPABILITIES,
    onRestarted: () => {
      events.restarted += 1
    },
    onDisconnected: () => {
      events.disconnected += 1
      bridge.reset()
    },
    onUnavailable: (code) => {
      events.unavailable = code
    }
  })
  const snapshot = async (runId: string): Promise<RunSnapshot> =>
    await client.request<RunSnapshot>('run.snapshot', { workspaceId: 'local-personal', runId })
  return {
    directory,
    client,
    events,
    snapshot,
    close: async () => {
      await service.stop()
      client.close()
      for (const child of mocks.children.splice(0)) child.kill('SIGKILL')
      await rm(directory, { recursive: true, force: true })
    }
  }
}

describe('isolated runtime crash recovery', () => {
  it('detects the utilityProcess backend only where Electron provides it', () => {
    expect(isolatedRuntimeSupported()).toBe(true)
  })

  it('restarts after a crash and leaves the unfinished run interrupted, not silently lost', async () => {
    await exec(process.execPath, ['scripts/build-ts-runtime.mjs'])
    mocks.crashOnReady = false
    const provider: ProviderAdapter = {
      async *stream(input) {
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        yield { type: 'text', text: 'never delivered' }
      }
    }
    const h = await setup(provider)
    try {
      await h.client.request('run.submit', spec('crashed'))
      await expect
        .poll(async () => (await h.snapshot('crashed')).run.status, { timeout: 20_000 })
        .toBe('running')
      mocks.children[0].kill('SIGKILL')
      await expect.poll(() => h.events.restarted, { timeout: 20_000 }).toBe(1)
      expect(h.events.disconnected).toBe(1)
      await expect(h.client.request('ping')).resolves.toMatchObject({
        version: RUNTIME_PROTOCOL_VERSION
      })
      const recovered = await h.snapshot('crashed')
      expect(recovered.run.status).toBe('interrupted')
      const terminal = recovered.events.filter((event) => event.type === 'run.status').at(-1)
      expect((terminal?.data as { reason: string }).reason).toBe(
        'RUNTIME_RESTARTED_REVIEW_SIDE_EFFECTS'
      )
      // A restarted runtime must not replay the side effects of the lost run.
      expect(mocks.children).toHaveLength(2)
    } finally {
      await h.close()
    }
  }, 60_000)

  it('gives up after repeated failures instead of restarting forever', async () => {
    await exec(process.execPath, ['scripts/build-ts-runtime.mjs'])
    mocks.crashOnReady = false
    const provider: ProviderAdapter = {
      async *stream() {
        yield { type: 'text', text: 'unused' }
      }
    }
    const h = await setup(provider)
    try {
      // Every replacement dies as soon as it reports ready, so the failure
      // streak must survive `ready` and eventually stop the supervisor.
      mocks.crashOnReady = true
      mocks.children[0].kill('SIGKILL')
      await expect.poll(() => h.events.unavailable, { timeout: 40_000 }).toBe('RUNTIME_UNAVAILABLE')
      expect(mocks.children.length).toBeGreaterThanOrEqual(6)
    } finally {
      mocks.crashOnReady = false
      await h.close()
    }
  }, 90_000)
})
