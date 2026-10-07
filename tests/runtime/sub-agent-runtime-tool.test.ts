import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSubAgentRuntimeTool } from '../../src/main/runtime/sub-agent-runtime-tool'
import type { RunSnapshot, RunSpec } from '../../src/shared/runtime/contracts'
import type { ToolContext } from '../../src/runtime/tools/tool-executor'
import type { AgentInfo } from '../../src/main/user-content/agent-catalog'

const manifestPatches: unknown[] = []
let teamTasks: Array<Record<string, unknown>> = []

vi.mock('../../src/main/teams/team-runtime-store', () => ({
  TeamRuntimeStore: class {
    async updateMember(): Promise<{ success: true }> {
      return { success: true }
    }

    async snapshot(): Promise<{ team: { tasks: never[] } }> {
      return { team: { tasks: [] } }
    }

    async updateManifestPatch(input: unknown): Promise<{ success: true }> {
      manifestPatches.push(input)
      return { success: true }
    }

    async mutateManifest(input: {
      mutate: (manifest: { tasks: Array<Record<string, unknown>> }) => void
    }): Promise<void> {
      const manifest = { tasks: teamTasks }
      input.mutate(manifest)
      teamTasks = manifest.tasks
      manifestPatches.push({ patch: manifest })
    }
  }
}))

function run(): RunSpec {
  return {
    runId: 'parent-run',
    taskId: 'parent-task',
    requestId: 'request',
    traceId: 'trace',
    sessionId: 'parent-session',
    workspaceId: 'local-personal',
    environmentId: 'local',
    workingDirectory: '/tmp/ola-project',
    toolNames: ['Read', 'Write', 'Task', 'Agent', 'EnterPlanMode', 'ExitPlanMode'],
    modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
    prompt: 'parent',
    unattended: false
  }
}

function snapshot(status: RunSnapshot['run']['status'], text = 'done'): RunSnapshot {
  return {
    run: {
      ...run(),
      runId: 'child-run',
      taskId: 'subagent:child',
      sessionId: 'child-session',
      status,
      seq: 1,
      createdAt: 1,
      updatedAt: 2
    },
    events: [
      {
        runId: 'child-run',
        workspaceId: 'local-personal',
        seq: 1,
        traceId: 'child-trace',
        type: 'message.completed',
        data: { text },
        timestamp: 2
      }
    ],
    pendingInteractions: []
  }
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    run: run(),
    signal: new AbortController().signal,
    ...overrides
  }
}

describe('TS Task runtime tool', () => {
  beforeEach(() => {
    manifestPatches.splice(0)
    teamTasks = []
  })

  it('runs a synchronous child with inherited capabilities minus Task recursion', async () => {
    const tool = createSubAgentRuntimeTool()
    let submitted: Record<string, unknown> | undefined
    const result = await tool.execute(
      { description: 'inspect code', prompt: 'Inspect the project', subagent_type: 'custom' },
      context({
        runNested: async (input) => {
          submitted = input as Record<string, unknown>
          return snapshot('completed', 'inspection report')
        }
      })
    )
    expect(submitted?.toolNames).toEqual(['Read', 'Write'])
    expect(submitted?.taskId).toMatch(/^subagent:/)
    expect(submitted?.sessionId).not.toBe('parent-session')
    expect(JSON.parse(result as string)).toMatchObject({
      status: 'completed',
      report: 'inspection report'
    })
  })

  it('uses the current custom agent snapshot for schema, prompt, tool scope and turn limit', async () => {
    const agent: AgentInfo = {
      name: 'reviewer',
      description: 'Review files',
      tools: ['Read'],
      allowedTools: ['Read'],
      disallowedTools: [],
      maxTurns: 3,
      maxIterations: 3,
      systemPrompt: 'Review only the requested files.'
    }
    const tool = createSubAgentRuntimeTool('Task', [agent])
    expect(
      (tool.inputSchema as { properties: { subagent_type: { enum: string[] } } }).properties
        .subagent_type.enum
    ).toEqual(['reviewer', 'custom'])
    let submitted: RunSpec | undefined
    await tool.execute(
      tool.validate({
        description: 'inspect',
        prompt: 'Inspect project',
        subagent_type: 'reviewer'
      }),
      context({
        runNested: async (input) => {
          submitted = input as RunSpec
          return snapshot('completed')
        }
      })
    )
    expect(submitted?.toolNames).toEqual(['Read'])
    expect(submitted?.maxTurns).toBe(3)
    expect(submitted?.modelOptions?.systemPrompt).toContain('Review only the requested files.')
    await expect(
      tool.execute(
        tool.validate({
          description: 'inspect',
          prompt: 'Inspect project',
          subagent_type: 'removed'
        }),
        context({ runNested: async () => snapshot('completed') })
      )
    ).rejects.toThrow('INVALID_TOOL_INPUT')
  })

  it('submits background work and rejects unattended sub-agent requests explicitly', async () => {
    const tool = createSubAgentRuntimeTool()
    let submitted = false
    const background = await tool.execute(
      tool.validate({
        description: 'background',
        prompt: 'work',
        run_in_background: true,
        team_name: 'runtime-team',
        name: 'worker-one'
      }),
      context({
        run: { ...run(), teamContext: { teamName: 'runtime-team', memberName: 'lead' } },
        submitNested: async (input) => {
          submitted = true
          expect((input as Record<string, unknown>).unattended).toBe(true)
          return snapshot('queued').run
        }
      })
    )
    expect(submitted).toBe(true)
    expect(manifestPatches).toHaveLength(1)
    expect(manifestPatches[0]).toMatchObject({
      patch: { tasks: [{ id: expect.any(String), status: 'in_progress', owner: 'worker-one' }] }
    })
    expect(JSON.parse(background as string)).toMatchObject({ background: true, status: 'queued' })

    await expect(
      tool.execute(
        tool.validate({ description: 'channel', prompt: 'work' }),
        context({
          run: { ...run(), unattended: true },
          runNested: async () => snapshot('completed')
        })
      )
    ).rejects.toThrow('UNATTENDED_SUBAGENT_FORBIDDEN')
  })

  it('projects cancelled and failed background runs to matching terminal task states', async () => {
    const tool = createSubAgentRuntimeTool()
    let terminal: ((snapshot: RunSnapshot) => Promise<void>) | undefined
    await tool.execute(
      tool.validate({
        description: 'background',
        prompt: 'work',
        run_in_background: true,
        team_name: 'runtime-team',
        name: 'worker-one'
      }),
      context({
        run: { ...run(), teamContext: { teamName: 'runtime-team', memberName: 'lead' } },
        submitNested: async (_input, onTerminal) => {
          terminal = onTerminal
          return snapshot('queued').run
        }
      })
    )
    expect(teamTasks).toHaveLength(1)
    await terminal?.(snapshot('cancelled', 'cancelled by leader'))
    expect(teamTasks[0]).toMatchObject({ status: 'cancelled', report: 'cancelled by leader' })
  })
})
