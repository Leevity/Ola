import { expect, it, vi } from 'vitest'
import type { HookEvent, HookInvocation, HookOutput } from '../../src/shared/hooks/types'
import { ToolExecutor, type ToolDefinition } from '../../src/runtime/tools/tool-executor'
import { withToolHooks } from '../../src/main/runtime/tool-hook-lifecycle'
import type { RunSpec } from '../../src/shared/runtime/contracts'

const run = {
  runId: 'run-a',
  taskId: 'task-a',
  requestId: 'request-a',
  traceId: 'trace-a',
  sessionId: 'session-a',
  workspaceId: 'team-a',
  environmentId: 'local',
  modelSource: { kind: 'local', providerId: 'p', modelId: 'm' },
  prompt: 'hello',
  unattended: false
} as RunSpec

function context() {
  return { run, signal: new AbortController().signal }
}

/** A tool that records every stage it reached, so ordering is observable. */
function recordingTool(overrides: Partial<ToolDefinition> = {}) {
  const execute = vi.fn(async (input: unknown) => `ran:${JSON.stringify(input)}`)
  const tool: ToolDefinition = {
    name: 'Write',
    description: 'writes',
    inputSchema: { type: 'object' },
    effect: 'write',
    validate: (input) => {
      const value = input as { path?: unknown }
      if (!value || typeof value.path !== 'string') throw new Error('INVALID_TOOL_INPUT')
      return value
    },
    resources: async (input) => [`lock:${(input as { path: string }).path}`],
    execute,
    ...overrides
  }
  return { tool, execute }
}

function hooks(outputs: Partial<HookOutput>[]): {
  emit: (event: HookEvent, invocation: HookInvocation) => Promise<HookOutput[]>
  calls: Array<{ event: HookEvent; invocation: HookInvocation }>
} {
  const calls: Array<{ event: HookEvent; invocation: HookInvocation }> = []
  return {
    calls,
    emit: async (event, invocation) => {
      calls.push({ event, invocation })
      return event === 'preToolUse' || event === 'postToolUse' ? (outputs as HookOutput[]) : []
    }
  }
}

function executorFor(tool: ToolDefinition, emit: ReturnType<typeof hooks>['emit']) {
  return new ToolExecutor(
    withToolHooks([tool], {
      sessionId: 'session-a',
      projectPath: '/project',
      isPolicySession: false,
      emit
    }),
    async () => true
  )
}

it('denies a tool call when preToolUse returns deny, without executing it', async () => {
  const { tool, execute } = recordingTool()
  const hook = hooks([{ permissionDecision: 'deny', block: { reason: 'policy' } }])
  const results = await executorFor(tool, hook.emit).executeAll(
    [{ id: 'call-1', name: 'Write', input: { path: 'a.txt' } }],
    context(),
    async () => undefined
  )
  expect(results).toEqual([
    { id: 'call-1', name: 'Write', output: 'PERMISSION_DENIED', isError: true }
  ])
  expect(execute).not.toHaveBeenCalled()
})

it('authorizes and locks the input a preToolUse hook rewrote', async () => {
  const seen: string[] = []
  const { tool, execute } = recordingTool({
    resources: async (input) => {
      seen.push(`resources:${(input as { path: string }).path}`)
      return [`lock:${(input as { path: string }).path}`]
    }
  })
  const authorize = vi.fn(async (_tool: unknown, input: unknown) => {
    seen.push(`authorize:${(input as { path: string }).path}`)
    return true
  })
  const hook = hooks([{ updatedInput: { path: 'rewritten.txt' } }])
  const executor = new ToolExecutor(
    withToolHooks([tool], {
      sessionId: 'session-a',
      isPolicySession: false,
      emit: hook.emit
    }),
    authorize
  )
  const results = await executor.executeAll(
    [{ id: 'call-1', name: 'Write', input: { path: 'original.txt' } }],
    context(),
    async () => undefined
  )
  expect(results[0].output).toBe('ran:{"path":"rewritten.txt"}')
  expect(execute).toHaveBeenCalledTimes(1)
  expect(seen).toEqual(['authorize:rewritten.txt', 'resources:rewritten.txt'])
})

it('rejects a rewritten input that breaks the tool contract', async () => {
  const { tool, execute } = recordingTool()
  const hook = hooks([{ updatedInput: { notAPath: true } }])
  const results = await executorFor(tool, hook.emit).executeAll(
    [{ id: 'call-1', name: 'Write', input: { path: 'a.txt' } }],
    context(),
    async () => undefined
  )
  expect(results[0].output).toBe('INVALID_TOOL_INPUT')
  expect(execute).not.toHaveBeenCalled()
})

it('replaces the model-visible output with postToolUse feedback', async () => {
  const { tool, execute } = recordingTool({ effect: 'read' })
  const hook = hooks([{ replacementToolFeedback: 'redacted' }])
  const results = await executorFor(tool, hook.emit).executeAll(
    [{ id: 'call-1', name: 'Write', input: { path: 'a.txt' } }],
    context(),
    async () => undefined
  )
  expect(execute).toHaveBeenCalledTimes(1)
  expect(results[0]).toMatchObject({ output: 'redacted' })
  expect(results[0].isError).toBeUndefined()
  expect(hook.calls.map((call) => call.event)).toEqual(['preToolUse', 'postToolUse'])
  expect(hook.calls[1].invocation.toolResult).toBe('ran:{"path":"a.txt"}')
})

it('appends postToolUse context instead of replacing the output', async () => {
  const { tool } = recordingTool({ effect: 'read' })
  const hook = hooks([{ additionalContext: 'seen by policy' }])
  const results = await executorFor(tool, hook.emit).executeAll(
    [{ id: 'call-1', name: 'Write', input: { path: 'a.txt' } }],
    context(),
    async () => undefined
  )
  expect(results[0].output).toBe('ran:{"path":"a.txt"}\n\nseen by policy')
})

it('does not spawn hooks for a scenario-policy session', async () => {
  const { tool, execute } = recordingTool()
  const emit = vi.fn(async () => [{ permissionDecision: 'deny' as const }])
  const results = await new ToolExecutor(
    withToolHooks([tool], { sessionId: 'session-a', isPolicySession: true, emit }),
    async () => true
  ).executeAll(
    [{ id: 'call-1', name: 'Write', input: { path: 'a.txt' } }],
    context(),
    async () => undefined
  )
  expect(emit).not.toHaveBeenCalled()
  expect(execute).toHaveBeenCalledTimes(1)
  expect(results[0].isError).toBeUndefined()
})

it('fails open when the hook runner throws', async () => {
  const { tool, execute } = recordingTool()
  const emit = vi.fn(async () => {
    throw new Error('timed-out')
  })
  const results = await executorFor(tool, emit).executeAll(
    [{ id: 'call-1', name: 'Write', input: { path: 'a.txt' } }],
    context(),
    async () => undefined
  )
  expect(execute).toHaveBeenCalledTimes(1)
  expect(results[0].output).toBe('ran:{"path":"a.txt"}')
  expect(results[0].isError).toBeUndefined()
})

it('keeps structured results intact for the runtime readers', async () => {
  const structured = {
    __runtimeToolImage: {
      mimeType: 'image/png',
      assetId: '00000000-0000-4000-8000-000000000000'
    },
    text: 'ok'
  }
  const { tool } = recordingTool({
    effect: 'read',
    serializeReads: true,
    execute: async () => structured
  })
  const hook = hooks([{ replacementToolFeedback: 'ignored', additionalContext: 'note' }])
  const results = await executorFor(tool, hook.emit).executeAll(
    [{ id: 'call-1', name: 'Write', input: { path: 'a.txt' } }],
    context(),
    async () => undefined
  )
  expect(results[0].isError).toBeUndefined()
  expect(results[0].output).toBe('ok')
  expect(results[0].images).toEqual([
    { mimeType: 'image/png', assetId: '00000000-0000-4000-8000-000000000000' }
  ])
})
