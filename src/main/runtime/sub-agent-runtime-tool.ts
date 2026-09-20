import { randomUUID } from 'node:crypto'
import { RuntimeError, type RunSnapshot } from '../../shared/runtime/contracts'
import type { ToolContext, ToolDefinition } from '../../runtime/tools/tool-executor'
import { TeamRuntimeStore } from '../teams/team-runtime-store'

const MAX_DESCRIPTION_LENGTH = 256
const MAX_PROMPT_LENGTH = 128 * 1024

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value.trim()
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined
  return text(value, max)
}

function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value as Record<string, unknown>
}

function validateTaskInput(value: unknown): {
  description: string
  prompt: string
  subagentType: string
  background: boolean
  teamName?: string
  name?: string
  taskId?: string
} {
  const input = inputRecord(value)
  if (input.run_in_background !== undefined && input.run_in_background !== true)
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return {
    description: text(input.description, MAX_DESCRIPTION_LENGTH),
    prompt: text(input.prompt, MAX_PROMPT_LENGTH),
    subagentType: optionalText(input.subagent_type, 128) ?? 'custom',
    background: input.run_in_background === true,
    ...(input.team_name !== undefined ? { teamName: text(input.team_name, 128) } : {}),
    ...(input.name !== undefined ? { name: text(input.name, 128) } : {}),
    ...(input.task_id !== undefined ? { taskId: text(input.task_id, 256) } : {})
  }
}

function completedText(snapshot: RunSnapshot): string {
  const completed = snapshot.events
    .filter((event) => event.type === 'message.completed')
    .map((event) => {
      const data = event.data
      return data &&
        typeof data === 'object' &&
        typeof (data as { text?: unknown }).text === 'string'
        ? (data as { text: string }).text
        : ''
    })
    .filter(Boolean)
  return completed.at(-1) ?? ''
}

function subAgentSystemPrompt(type: string, workingDirectory?: string): string {
  return [
    'You are a focused Ola TS sub-agent executing one delegated task.',
    `Agent type: ${type}.`,
    'Work autonomously and return a concise report containing the result, changed files, and verification evidence.',
    'Do not use Task recursively. Do not claim work that you did not perform.',
    ...(workingDirectory ? [`Working directory: ${workingDirectory}`] : [])
  ].join('\n')
}

/** Main-owned synchronous Task execution for the TS runtime. */
export function createSubAgentRuntimeTool(name: 'Task' | 'Agent' = 'Task'): ToolDefinition {
  const teamStore = new TeamRuntimeStore()
  return {
    name,
    description:
      'Run one focused sub-agent task inside the TS runtime and return its final report.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', minLength: 1, maxLength: MAX_DESCRIPTION_LENGTH },
        prompt: { type: 'string', minLength: 1, maxLength: MAX_PROMPT_LENGTH },
        subagent_type: { type: 'string', minLength: 1, maxLength: 128 },
        run_in_background: { type: 'boolean', const: true },
        name: { type: 'string', minLength: 1, maxLength: 128 },
        team_name: { type: 'string', minLength: 1, maxLength: 128 },
        task_id: { type: 'string', minLength: 1, maxLength: 256 },
        backend_type: { type: 'string', enum: ['in-process'] },
        model: { type: 'string', minLength: 1, maxLength: 128 }
      },
      required: ['description', 'prompt'],
      additionalProperties: false
    },
    effect: 'write',
    validate: validateTaskInput,
    resources: async (_input, context) => [
      `subagent:${context.run.workspaceId}:${context.run.runId}`
    ],
    execute: async (rawInput, context: ToolContext) => {
      const input = rawInput as ReturnType<typeof validateTaskInput>
      if (context.run.unattended) throw new RuntimeError('UNATTENDED_SUBAGENT_FORBIDDEN')
      if (!context.runNested && !context.submitNested)
        throw new RuntimeError('NESTED_RUNTIME_UNAVAILABLE')

      const childToolNames = (context.run.toolNames ?? []).filter(
        (toolName) =>
          toolName !== 'Task' &&
          toolName !== 'Agent' &&
          toolName !== 'EnterPlanMode' &&
          toolName !== 'ExitPlanMode'
      )
      const teamName = input.teamName ?? context.run.teamContext?.teamName
      if (input.background && !teamName) throw new RuntimeError('TEAM_NOT_ACTIVE')
      if (input.teamName && context.run.teamContext && input.teamName !== teamName)
        throw new RuntimeError('TEAM_MISMATCH')
      const memberName = input.name ?? `worker-${randomUUID().slice(0, 8)}`
      const childTaskId = input.taskId ?? `task-${randomUUID()}`
      if (input.background && teamName) {
        await teamStore.updateMember({
          teamName,
          workspaceId: context.run.workspaceId,
          memberId: memberName,
          patch: {
            name: memberName,
            role: 'worker',
            status: 'working',
            currentTaskId: childTaskId,
            runId: undefined,
            sessionId: undefined,
            isActive: true,
            startedAt: Date.now(),
            completedAt: null
          }
        })
        await teamStore.mutateManifest({
          teamName,
          workspaceId: context.run.workspaceId,
          mutate: (manifest) => {
            if (manifest.tasks.some((task) => task.id === childTaskId)) return
            manifest.tasks.push({
              id: childTaskId,
              subject: input.description,
              description: input.prompt,
              status: 'in_progress',
              owner: memberName,
              dependsOn: []
            })
          }
        })
      }
      const childInput = {
        runId: randomUUID(),
        taskId: `subagent:${randomUUID()}`,
        requestId: randomUUID(),
        traceId: randomUUID(),
        sessionId: randomUUID(),
        workspaceId: context.run.workspaceId,
        environmentId: context.run.environmentId,
        ...(context.run.workingDirectory ? { workingDirectory: context.run.workingDirectory } : {}),
        ...(context.run.extensionIds?.length ? { extensionIds: context.run.extensionIds } : {}),
        ...(childToolNames.length ? { toolNames: childToolNames } : {}),
        modelSource: context.run.modelSource,
        ...(teamName ? { teamContext: { teamName, memberName } } : {}),
        ...(context.run.modelOptions
          ? {
              modelOptions: {
                ...context.run.modelOptions,
                systemPrompt: subAgentSystemPrompt(input.subagentType, context.run.workingDirectory)
              }
            }
          : {
              modelOptions: {
                systemPrompt: subAgentSystemPrompt(input.subagentType, context.run.workingDirectory)
              }
            }),
        prompt: input.prompt,
        unattended: input.background,
        maxTurns: Math.min(context.run.maxTurns ?? 32, 32),
        maxToolCalls: Math.min(context.run.maxToolCalls ?? 128, 128)
      }
      if (input.background) {
        const child = await context.submitNested!(childInput, async (snapshot) => {
          const succeeded = snapshot.run.status === 'completed'
          const taskStatus = succeeded
            ? 'completed'
            : snapshot.run.status === 'cancelled'
              ? 'cancelled'
              : 'failed'
          await teamStore.updateMember({
            teamName: teamName!,
            workspaceId: context.run.workspaceId,
            memberId: memberName,
            patch: {
              status: succeeded ? 'idle' : 'stopped',
              currentTaskId: null,
              runId: undefined,
              sessionId: undefined,
              isActive: succeeded,
              completedAt: Date.now()
            }
          })
          await teamStore.mutateManifest({
            teamName: teamName!,
            workspaceId: context.run.workspaceId,
            mutate: (manifest) => {
              const task = manifest.tasks.find((item) => item.id === childTaskId)
              if (!task) return
              Object.assign(task, {
                status: taskStatus,
                report: completedText(snapshot) || `child run ${snapshot.run.status}`
              })
            }
          })
        })
        await teamStore.updateMember({
          teamName: teamName!,
          workspaceId: context.run.workspaceId,
          memberId: memberName,
          patch: { runId: child.runId, sessionId: child.sessionId }
        })
        return JSON.stringify({
          runId: child.runId,
          status: child.status,
          description: input.description,
          ...(teamName ? { teamName, memberName, taskId: childTaskId } : {}),
          background: true
        })
      }
      const child = await context.runNested!(childInput)
      const report = completedText(child)
      return JSON.stringify({
        runId: child.run.runId,
        status: child.run.status,
        description: input.description,
        ...(teamName ? { teamName, memberName, taskId: childTaskId } : {}),
        report: report || undefined
      })
    }
  }
}
