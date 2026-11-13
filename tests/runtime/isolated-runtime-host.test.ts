import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntimeHostBridge } from '../../src/main/runtime/runtime-host-bridge'
import { RuntimeClient } from '../../src/runtime/host/runtime-client'
import { startIsolatedRuntime } from '../../src/runtime/host/isolated-runtime'
import { ToolExecutor, type ToolDefinition } from '../../src/runtime/tools/tool-executor'
import type { AgentMessage, ProviderAdapter } from '../../src/shared/runtime/model'
import {
  RuntimeError,
  TERMINAL_STATUSES,
  type RunSnapshot,
  type RunSpec
} from '../../src/shared/runtime/contracts'
import type { HostProviderStreamParams } from '../../src/shared/runtime/host-protocol'

/** Resolved in Main only. Nothing below may put it on the wire. */
const MAIN_ONLY_KEY = 'sk-main-only-credential'

function spec(runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    unattended: true,
    ...overrides
  }
}

function tool(name: string, execute: ToolDefinition['execute']): ToolDefinition {
  return {
    name,
    effect: 'read',
    execute,
    description: name,
    inputSchema: {},
    validate: (value) => value,
    resources: async () => []
  }
}

async function harness(options: {
  provider: ProviderAdapter
  tools?: ToolDefinition[]
  authorizeTool?: ConstructorParameters<typeof ToolExecutor>[1]
  authorize?: (run: RunSpec) => Promise<void>
}) {
  const directory = await mkdtemp(join(tmpdir(), 'ola-isolated-host-'))
  const client = new RuntimeClient()
  const seen: Array<{ method: string; params: unknown }> = []
  const bridge = createRuntimeHostBridge({
    client,
    authorize: options.authorize ?? (async () => undefined),
    provider: options.provider,
    tools: async () =>
      new ToolExecutor(options.tools ?? [], options.authorizeTool ?? (async () => true)),
    workspaceIds: async () => new Set(['local-personal'])
  })
  client.onRequest(async (method, params) => {
    seen.push({ method, params })
    return bridge.handle(method, params)
  })
  const service = await startIsolatedRuntime(directory)
  await client.connect(service.endpoint, service.token)
  const snapshot = async (runId: string): Promise<RunSnapshot> =>
    await client.request<RunSnapshot>('run.snapshot', { workspaceId: 'local-personal', runId })
  const settled = async (runId: string): Promise<RunSnapshot> => {
    await expect
      .poll(async () => TERMINAL_STATUSES.has((await snapshot(runId)).run.status), {
        timeout: 10_000
      })
      .toBe(true)
    return await snapshot(runId)
  }
  const streams = (): HostProviderStreamParams[] =>
    seen
      .filter((entry) => entry.method === 'provider.stream')
      .map((entry) => entry.params as HostProviderStreamParams)
  return {
    directory,
    client,
    bridge,
    seen,
    streams,
    snapshot,
    settled,
    close: async () => {
      client.close()
      await service.stop()
      await rm(directory, { recursive: true, force: true })
    }
  }
}

describe('isolated runtime with a Main-side host', () => {
  it('completes a model/tool/model loop with tools and credentials owned by Main', async () => {
    const conversations: Array<readonly AgentMessage[]> = []
    const executed: string[] = []
    const provider: ProviderAdapter = {
      async *stream(input) {
        conversations.push([...input.messages])
        // The key is read here, in Main, and never becomes part of any payload.
        expect(MAIN_ONLY_KEY).toMatch(/^sk-/)
        if (conversations.length === 1)
          yield { type: 'tool', call: { id: 'c1', name: 'Read', input: { path: 'a' } } }
        else yield { type: 'text', text: 'done' }
      }
    }
    const h = await harness({
      provider,
      tools: [
        tool('Read', async (input) => {
          executed.push((input as { path: string }).path)
          return 'file-body'
        })
      ]
    })
    try {
      await h.client.request('run.submit', spec('loop'))
      const final = await h.settled('loop')
      expect(final.run.status).toBe('completed')
      expect(executed).toEqual(['a'])
      const results = final.events.filter((event) => event.type === 'tool.result')
      expect(results).toHaveLength(1)
      expect((results[0].data as { output: string }).output).toBe('file-body')
      // Main reassembled the conversation the child only sent incrementally.
      expect(conversations[1].map((message) => message.role)).toEqual(['user', 'assistant', 'tool'])
      expect(JSON.stringify(final)).not.toContain(MAIN_ONLY_KEY)
      expect(JSON.stringify(h.seen)).not.toContain(MAIN_ONLY_KEY)
      // A credential field on the wire spec would defeat the whole proxy.
      expect(Object.keys(h.streams()[0].run!.modelSource)).toEqual([
        'kind',
        'providerId',
        'modelId'
      ])
    } finally {
      await h.close()
    }
  })

  it('sends only the messages the agent appended after the first turn', async () => {
    let turn = 0
    const provider: ProviderAdapter = {
      async *stream() {
        if (turn++ === 0) yield { type: 'tool', call: { id: 'c1', name: 'Read', input: {} } }
        else yield { type: 'text', text: 'done' }
      }
    }
    const h = await harness({ provider, tools: [tool('Read', async () => 'ok')] })
    try {
      await h.client.request('run.submit', spec('incremental'))
      await h.settled('incremental')
      const streams = h.streams()
      expect(streams).toHaveLength(2)
      expect(streams[0].reset).toBe(true)
      expect(streams[0].messages).toHaveLength(1)
      expect(streams[1].reset).toBe(false)
      expect(streams[1].run).toBeUndefined()
      expect(streams[1].messages.map((message) => message.role)).toEqual(['assistant', 'tool'])
    } finally {
      await h.close()
    }
  })

  it('routes a tool approval through the run journal and back to the tool', async () => {
    const provider: ProviderAdapter = {
      async *stream(input) {
        if (input.messages.some((message) => message.role === 'tool'))
          yield { type: 'text', text: 'approved' }
        else yield { type: 'tool', call: { id: 'c1', name: 'Write', input: {} } }
      }
    }
    let asked = 0
    const h = await harness({
      provider,
      tools: [tool('Write', async () => 'written')],
      authorizeTool: async (_tool, _input, context) => {
        asked += 1
        const answer = await context.requestInteraction!({
          interactionId: 'approval-1',
          kind: 'tool-approval',
          payload: { name: 'Write' }
        })
        return answer === 'allow'
      }
    })
    try {
      await h.client.request('run.submit', spec('approval', { unattended: false }))
      await expect
        .poll(async () => (await h.snapshot('approval')).pendingInteractions.length, {
          timeout: 10_000
        })
        .toBe(1)
      const pending = (await h.snapshot('approval')).pendingInteractions[0]
      expect(pending.kind).toBe('tool-approval')
      await h.client.request('run.interact', {
        workspaceId: 'local-personal',
        runId: 'approval',
        interactionId: pending.interactionId,
        response: 'allow'
      })
      const final = await h.settled('approval')
      expect(final.run.status).toBe('completed')
      expect(asked).toBe(1)
      expect(
        final.events.some(
          (event) =>
            event.type === 'tool.result' && (event.data as { output: string }).output === 'written'
        )
      ).toBe(true)
    } finally {
      await h.close()
    }
  })

  it('runs a nested run in the child and returns its terminal snapshot to Main', async () => {
    const provider: ProviderAdapter = {
      async *stream(input) {
        if (input.run.runId === 'parent') {
          if (input.messages.some((message) => message.role === 'tool'))
            yield { type: 'text', text: 'parent-done' }
          else yield { type: 'tool', call: { id: 'c1', name: 'Delegate', input: {} } }
        } else yield { type: 'text', text: 'child-done' }
      }
    }
    let nestedStatus = ''
    const h = await harness({
      provider,
      tools: [
        tool('Delegate', async (_input, context) => {
          const snapshot = await context.runNested!(spec('child'))
          nestedStatus = snapshot.run.status
          return snapshot.run.status
        })
      ]
    })
    try {
      await h.client.request('run.submit', spec('parent'))
      const final = await h.settled('parent')
      expect(final.run.status).toBe('completed')
      expect(nestedStatus).toBe('completed')
      expect((await h.snapshot('child')).run.status).toBe('completed')
    } finally {
      await h.close()
    }
  })

  it('aborts the Main-side model stream when the run is cancelled', async () => {
    let aborted = false
    let streaming = false
    const provider: ProviderAdapter = {
      async *stream(input) {
        streaming = true
        input.signal.addEventListener('abort', () => {
          aborted = true
        })
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve()
          else input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        yield { type: 'text', text: 'never' }
      }
    }
    const h = await harness({ provider })
    try {
      await h.client.request('run.submit', spec('cancelled'))
      await expect.poll(() => streaming, { timeout: 10_000 }).toBe(true)
      await h.client.request('run.cancel', { workspaceId: 'local-personal', runId: 'cancelled' })
      const final = await h.settled('cancelled')
      expect(final.run.status).toBe('cancelled')
      expect(aborted).toBe(true)
      expect(h.seen.some((entry) => entry.method === 'provider.stream.cancel')).toBe(true)
    } finally {
      await h.close()
    }
  })

  it('refuses submission when Main denies authorization', async () => {
    const provider: ProviderAdapter = {
      async *stream() {
        yield { type: 'text', text: 'unused' }
      }
    }
    const h = await harness({
      provider,
      authorize: async () => {
        throw new RuntimeError('WORKSPACE_FORBIDDEN')
      }
    })
    try {
      await expect(h.client.request('run.submit', spec('forbidden'))).rejects.toThrow(
        'WORKSPACE_FORBIDDEN'
      )
    } finally {
      await h.close()
    }
  })

  it('fails the run with the provider error code instead of hanging', async () => {
    const provider: ProviderAdapter = {
      async *stream() {
        yield { type: 'text', text: 'partial' }
        throw new RuntimeError('PROVIDER_UNAVAILABLE')
      }
    }
    const h = await harness({ provider })
    try {
      await h.client.request('run.submit', spec('provider-failure'))
      const final = await h.settled('provider-failure')
      expect(final.run.status).toBe('failed')
      const terminal = final.events.filter((event) => event.type === 'run.status').at(-1)
      expect((terminal?.data as { reason: string }).reason).toBe('PROVIDER_UNAVAILABLE')
    } finally {
      await h.close()
    }
  })

  it('releases Main-side run state when the run finishes', async () => {
    const provider: ProviderAdapter = {
      async *stream() {
        yield { type: 'text', text: 'done' }
      }
    }
    const h = await harness({ provider })
    try {
      await h.client.request('run.submit', spec('released'))
      await h.settled('released')
      await expect
        .poll(() => h.seen.some((entry) => entry.method === 'tool.release'), { timeout: 10_000 })
        .toBe(true)
      await expect(
        h.bridge.handle('tool.execute', { runId: 'released', calls: [] })
      ).rejects.toThrow('RUN_NOT_FOUND')
    } finally {
      await h.close()
    }
  })

  it('drops every tracked run when the runtime connection is lost', async () => {
    const provider: ProviderAdapter = {
      async *stream() {
        yield { type: 'text', text: 'done' }
      }
    }
    const h = await harness({ provider, tools: [tool('Read', async () => 'ok')] })
    try {
      await h.client.request('run.submit', spec('reset'))
      await h.settled('reset')
      await h.bridge.handle('tool.catalog', { run: spec('reset') })
      h.bridge.reset()
      await expect(h.bridge.handle('tool.execute', { runId: 'reset', calls: [] })).rejects.toThrow(
        'RUN_NOT_FOUND'
      )
    } finally {
      await h.close()
    }
  })
})
