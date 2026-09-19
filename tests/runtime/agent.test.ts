import { describe, expect, it } from 'vitest'
import {
  createAgentExecutor,
  type AgentMessage,
  type ProviderAdapter
} from '../../src/runtime/core/agent'
import {
  ToolExecutor,
  ResourceLocks,
  type ToolDefinition
} from '../../src/runtime/tools/tool-executor'
import type { RunSpec } from '../../src/shared/runtime/contracts'

const run: RunSpec = {
  runId: 'r',
  requestId: 'q',
  traceId: 't',
  taskId: 'j',
  sessionId: 's',
  workspaceId: 'local-personal',
  environmentId: 'local',
  modelSource: { kind: 'local', providerId: 'p', modelId: 'm' },
  prompt: 'read',
  unattended: true
}
const tool = (
  name: string,
  effect: 'read' | 'write',
  execute: ToolDefinition['execute']
): ToolDefinition => ({
  name,
  effect,
  execute,
  description: name,
  inputSchema: {},
  validate: (v) => v,
  resources: async () => (effect === 'write' ? ['local:/same-file'] : [])
})

describe('headless agent and tools', () => {
  it('runs a complete model/tool/model loop with injected capabilities', async () => {
    let turn = 0
    let history: readonly AgentMessage[] = []
    const provider: ProviderAdapter = {
      async *stream(input) {
        history = [...input.messages]
        if (turn++ === 0) yield { type: 'tool', call: { id: 'call', name: 'read', input: {} } }
        else yield { type: 'text', text: 'done' }
      }
    }
    const events: string[] = []
    await createAgentExecutor(
      provider,
      new ToolExecutor([tool('read', 'read', async () => 'file')], async () => true)
    )(run, {
      signal: new AbortController().signal,
      emit: async (type) => {
        events.push(type)
      },
      requestInteraction: async () => {
        throw new Error('not used')
      }
    })
    expect(
      history.some((message) => message.role === 'tool' && message.results[0].output === 'file')
    ).toBe(true)
    expect(events).toContain('tool.result')
    expect(events).toContain('tool.generated')
    expect(events.at(-1)).toBe('message.completed')
  })
  it('preserves prior textual turns before the current prompt', async () => {
    let history: readonly AgentMessage[] = []
    const provider: ProviderAdapter = {
      async *stream(input) {
        history = [...input.messages]
        yield { type: 'text', text: '' }
      }
    }
    await createAgentExecutor(provider, new ToolExecutor([], async () => false))(
      { ...run, history: [{ role: 'assistant', text: 'Earlier answer' }] },
      {
        signal: new AbortController().signal,
        emit: async () => undefined,
        requestInteraction: async () => undefined
      }
    )
    expect(history).toEqual([
      { role: 'assistant', text: 'Earlier answer', toolCalls: [] },
      { role: 'user', text: 'read' }
    ])
  })
  it('persists final provider usage with the completed turn', async () => {
    const completed: unknown[] = []
    const provider: ProviderAdapter = {
      async *stream() {
        yield { type: 'text', text: 'done' }
        yield { type: 'usage', inputTokens: 4, outputTokens: 2, cacheReadTokens: 1 }
      }
    }
    await createAgentExecutor(provider, new ToolExecutor([], async () => false))(run, {
      signal: new AbortController().signal,
      emit: async (type, data) => {
        if (type === 'message.completed') completed.push(data)
      },
      requestInteraction: async () => undefined
    })
    expect(completed).toEqual([
      {
        turn: 0,
        text: 'done',
        toolCalls: [],
        usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 1 }
      }
    ])
  })
  it('does not execute a denied write', async () => {
    let writes = 0
    const tools = new ToolExecutor(
      [
        tool('write', 'write', async () => {
          writes++
        })
      ],
      async () => false
    )
    const result = await tools.executeAll(
      [{ id: 'x', name: 'write', input: {} }],
      { run, signal: new AbortController().signal },
      async () => undefined
    )
    expect(result[0].output).toBe('PERMISSION_DENIED')
    expect(writes).toBe(0)
  })
  it('does not start a write after revocation while its resource is being resolved', async () => {
    const controller = new AbortController()
    let resolveResource!: () => void
    let resolving = false
    let writes = 0
    const definition: ToolDefinition = {
      ...tool('write', 'write', async () => {
        writes++
      }),
      resources: async () => {
        resolving = true
        await new Promise<void>((resolve) => {
          resolveResource = resolve
        })
        return ['local:/file']
      }
    }
    const tools = new ToolExecutor([definition], async () => true)
    const pending = tools.executeAll(
      [{ id: 'revoked-write', name: 'write', input: {} }],
      { run, signal: controller.signal },
      async () => undefined
    )
    await expect.poll(() => resolving).toBe(true)
    controller.abort(new Error('revoked'))
    resolveResource()
    await expect(pending).rejects.toThrow('revoked')
    expect(writes).toBe(0)
  })
  it('does not publish a tool result after revocation during execution', async () => {
    const controller = new AbortController()
    let finish!: () => void
    let started = false
    const events: string[] = []
    const tools = new ToolExecutor(
      [
        tool('read', 'read', async () => {
          started = true
          await new Promise<void>((resolve) => {
            finish = resolve
          })
          return 'stale result'
        })
      ],
      async () => true
    )
    const pending = tools.executeAll(
      [{ id: 'revoked-read', name: 'read', input: {} }],
      { run, signal: controller.signal },
      async (type) => {
        events.push(type)
      }
    )
    await expect.poll(() => started).toBe(true)
    controller.abort(new Error('revoked'))
    finish()
    await expect(pending).rejects.toThrow('revoked')
    expect(events).toContain('tool.started')
    expect(events).not.toContain('tool.result')
  })
  it('binds a write approval to the exact model tool-call id before executing', async () => {
    let writes = 0
    const approvals: unknown[] = []
    const tools = new ToolExecutor(
      [
        tool('write', 'write', async () => {
          writes++
        })
      ],
      async (definition, input, context, call) => {
        if (definition.effect !== 'write' || !context.requestInteraction) return false
        const response = await context.requestInteraction({
          interactionId: `tool-approval:${call.id}`,
          kind: 'tool-approval',
          payload: { id: call.id, name: definition.name, input },
          version: '1'
        })
        return !!response && (response as { approved?: unknown }).approved === true
      }
    )
    const result = await tools.executeAll(
      [{ id: 'exact-call', name: 'write', input: { path: 'safe.txt' } }],
      {
        run,
        signal: new AbortController().signal,
        requestInteraction: async (request) => {
          approvals.push(request)
          return { approved: true }
        }
      },
      async () => undefined
    )
    expect(approvals).toEqual([
      {
        interactionId: 'tool-approval:exact-call',
        kind: 'tool-approval',
        payload: { id: 'exact-call', name: 'write', input: { path: 'safe.txt' } },
        version: '1'
      }
    ])
    expect(result[0].isError).toBeUndefined()
    expect(writes).toBe(1)
  })
  it('serializes concurrent writes across runs using shared canonical resource locks', async () => {
    const locks = new ResourceLocks()
    let active = 0,
      maxActive = 0,
      value = ''
    const definition = tool('write', 'write', async () => {
      const before = value
      maxActive = Math.max(maxActive, ++active)
      await new Promise((r) => setTimeout(r, 5))
      value = before + 'x'
      active--
      return value
    })
    const tools = new ToolExecutor([definition], async () => true, locks)
    await Promise.all(
      ['a', 'b'].map((id) =>
        tools.executeAll(
          [{ id, name: 'write', input: {} }],
          { run, signal: new AbortController().signal },
          async () => undefined
        )
      )
    )
    expect(value).toBe('xx')
    expect(maxActive).toBe(1)
  })
  it('allows a bounded read batch to inspect the same resource concurrently', async () => {
    let active = 0
    let maxActive = 0
    const definition: ToolDefinition = {
      ...tool('read-shared', 'read', async () => {
        maxActive = Math.max(maxActive, ++active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active--
        return 'read'
      }),
      resources: async () => ['local:/same-file']
    }
    const tools = new ToolExecutor([definition], async () => true, new ResourceLocks())
    const results = await tools.executeAll(
      [
        { id: 'one', name: 'read-shared', input: {} },
        { id: 'two', name: 'read-shared', input: {} }
      ],
      { run, signal: new AbortController().signal },
      async () => undefined
    )
    expect(results.map((result) => result.output)).toEqual(['read', 'read'])
    expect(maxActive).toBe(2)
  })
  it('cancels a lock waiter promptly without allowing a later writer to overtake the owner', async () => {
    const locks = new ResourceLocks()
    let release!: () => void
    let entered = false
    const first = locks.with(['file'], new AbortController().signal, async () => {
      entered = true
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    await expect.poll(() => entered).toBe(true)
    const controller = new AbortController()
    const second = locks.with(['file'], controller.signal, async () => {
      throw new Error('must not execute')
    })
    const rejected = expect(second).rejects.toThrow('cancelled')
    controller.abort(new Error('cancelled'))
    await rejected
    let thirdEntered = false
    const third = locks.with(['file'], new AbortController().signal, async () => {
      thirdEntered = true
    })
    await Promise.resolve()
    expect(thirdEntered).toBe(false)
    release()
    await Promise.all([first, third])
    expect(thirdEntered).toBe(true)
  })
  it('stops looping at a bounded turn limit', async () => {
    let id = 0
    const provider: ProviderAdapter = {
      async *stream() {
        yield { type: 'tool', call: { id: String(id++), name: 'unknown', input: {} } }
      }
    }
    await expect(
      createAgentExecutor(
        provider,
        new ToolExecutor([], async () => false),
        2
      )(run, {
        signal: new AbortController().signal,
        emit: async () => undefined,
        requestInteraction: async () => {
          throw new Error('not used')
        }
      })
    ).rejects.toThrow('TURN_LIMIT_EXCEEDED')
  })
  it('does not execute a batch that exceeds the persisted tool-call budget', async () => {
    let executed = 0
    const provider: ProviderAdapter = {
      async *stream() {
        yield { type: 'tool', call: { id: 'first', name: 'read', input: {} } }
        yield { type: 'tool', call: { id: 'second', name: 'read', input: {} } }
      }
    }
    await expect(
      createAgentExecutor(
        provider,
        new ToolExecutor(
          [
            tool('read', 'read', async () => {
              executed++
              return 'never'
            })
          ],
          async () => true
        )
      )(
        { ...run, maxToolCalls: 1 },
        {
          signal: new AbortController().signal,
          emit: async () => undefined,
          requestInteraction: async () => undefined
        }
      )
    ).rejects.toThrow('TOOL_CALL_LIMIT_EXCEEDED')
    expect(executed).toBe(0)
  })
})
