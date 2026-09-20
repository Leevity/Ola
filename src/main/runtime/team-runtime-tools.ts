import { randomUUID } from 'node:crypto'
import { RuntimeError } from '../../shared/runtime/contracts'
import type {
  TeamRuntimeMessageType,
  TeamRuntimeTaskRecord,
  TeamRuntimeTaskStatus
} from '../../shared/team-runtime-types'
import type { ToolContext, ToolDefinition } from '../../runtime/tools/tool-executor'
import { TeamRuntimeStore } from '../teams/team-runtime-store'

const store = new TeamRuntimeStore()
const messageTypes = new Set([
  'message',
  'broadcast',
  'shutdown_request',
  'shutdown_response',
  'idle_notification',
  'permission_request',
  'permission_response',
  'plan_approval_request',
  'plan_approval_response',
  'team_permission_update',
  'mode_set_request'
])

function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value as Record<string, unknown>
}

function teamName(context: ToolContext): string {
  const value = context.run.teamContext?.teamName?.trim()
  if (!value) throw new RuntimeError('TEAM_NOT_ACTIVE')
  return value
}

function teamStatusTool(): ToolDefinition {
  return {
    name: 'TeamStatus',
    description: 'Read the current team members, tasks and recent collaboration messages.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    effect: 'read',
    validate: (value) => {
      inputRecord(value)
      return {}
    },
    resources: async (_input, context) => [`team:${teamName(context)}`],
    execute: async (_input, context) => {
      const snapshot = await store.snapshot({
        teamName: teamName(context),
        workspaceId: context.run.workspaceId,
        limit: 20
      })
      if (!snapshot) throw new RuntimeError('TEAM_NOT_FOUND')
      return JSON.stringify(snapshot)
    }
  }
}

function teamCreateTool(): ToolDefinition {
  return {
    name: 'TeamCreate',
    description: 'Create a persistent in-process team for parallel collaboration.',
    inputSchema: {
      type: 'object',
      properties: {
        team_name: { type: 'string', minLength: 1, maxLength: 128 },
        description: { type: 'string', minLength: 1, maxLength: 4096 }
      },
      required: ['team_name', 'description'],
      additionalProperties: false
    },
    effect: 'write',
    validate: (value) => {
      const input = inputRecord(value)
      const team = typeof input.team_name === 'string' ? input.team_name.trim() : ''
      const description = typeof input.description === 'string' ? input.description.trim() : ''
      if (!team || !description) throw new RuntimeError('INVALID_TOOL_INPUT')
      return { team_name: team, description }
    },
    resources: async (value) => [`team:${(value as { team_name: string }).team_name}`],
    execute: async (value, context) => {
      const input = value as { team_name: string; description: string }
      const result = await store.create({
        teamName: input.team_name,
        workspaceId: context.run.workspaceId,
        description: input.description,
        sessionId: context.run.sessionId,
        workingFolder: context.run.workingDirectory
      })
      context.run.teamContext = { teamName: result.teamName, memberName: 'lead' }
      return JSON.stringify(result)
    }
  }
}

function sendMessageTool(): ToolDefinition {
  return {
    name: 'SendMessage',
    description: 'Send a direct or broadcast message to the active team.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [...messageTypes] },
        recipient: { type: 'string' },
        content: { type: 'string', minLength: 1, maxLength: 32768 },
        summary: { type: 'string', maxLength: 1024 }
      },
      required: ['type', 'content'],
      additionalProperties: false
    },
    effect: 'write',
    validate: (value) => {
      const input = inputRecord(value)
      const type = typeof input.type === 'string' ? input.type : ''
      const content = typeof input.content === 'string' ? input.content.trim() : ''
      const recipient = typeof input.recipient === 'string' ? input.recipient.trim() : ''
      if (!messageTypes.has(type) || !content || (type !== 'broadcast' && !recipient))
        throw new RuntimeError('INVALID_TOOL_INPUT')
      return {
        type,
        content,
        ...(recipient ? { recipient } : {}),
        ...(typeof input.summary === 'string' && input.summary.trim()
          ? { summary: input.summary.trim() }
          : {})
      }
    },
    resources: async (_input, context) => [`team:${teamName(context)}`],
    execute: async (value, context) => {
      const input = value as {
        type: string
        content: string
        recipient?: string
        summary?: string
      }
      const message = {
        id: randomUUID(),
        from: context.run.teamContext?.memberName ?? 'lead',
        to: input.type === 'broadcast' ? 'all' : input.recipient!,
        type: input.type as TeamRuntimeMessageType,
        content: input.content,
        ...(input.summary ? { summary: input.summary } : {}),
        timestamp: Date.now()
      }
      await store.appendMessage({
        teamName: teamName(context),
        workspaceId: context.run.workspaceId,
        message
      })
      return JSON.stringify({ success: true, message })
    }
  }
}

function teamDeleteTool(): ToolDefinition {
  return {
    name: 'TeamDelete',
    description: 'Delete the active team and its persisted collaboration state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    effect: 'write',
    validate: (value) => {
      inputRecord(value)
      return {}
    },
    resources: async (_input, context) => [`team:${teamName(context)}`],
    execute: async (_input, context) => {
      const name = teamName(context)
      await store.delete({ teamName: name, workspaceId: context.run.workspaceId })
      delete context.run.teamContext
      return JSON.stringify({ success: true, teamName: name })
    }
  }
}

function taskCreateTool(): ToolDefinition {
  return {
    name: 'TeamTaskCreate',
    description: 'Create a persistent team task with an optional owner and dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', maxLength: 256 },
        subject: { type: 'string', minLength: 1, maxLength: 256 },
        description: { type: 'string', minLength: 1, maxLength: 8192 },
        owner: { type: 'string', maxLength: 128 },
        depends_on: { type: 'array', items: { type: 'string', maxLength: 256 }, maxItems: 32 }
      },
      required: ['subject', 'description'],
      additionalProperties: false
    },
    effect: 'write',
    validate: (value) => {
      const input = inputRecord(value)
      const subject = typeof input.subject === 'string' ? input.subject.trim() : ''
      const description = typeof input.description === 'string' ? input.description.trim() : ''
      const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : ''
      const owner = typeof input.owner === 'string' ? input.owner.trim() : ''
      const dependsOn = Array.isArray(input.depends_on)
        ? input.depends_on
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
        : []
      if (!subject || !description || taskId.length > 256 || dependsOn.some((item) => !item))
        throw new RuntimeError('INVALID_TOOL_INPUT')
      return {
        ...(taskId ? { task_id: taskId } : {}),
        subject,
        description,
        ...(owner ? { owner } : {}),
        depends_on: [...new Set(dependsOn)]
      }
    },
    resources: async (_input, context) => [`team:${teamName(context)}`],
    execute: async (value, context) => {
      const input = value as {
        task_id?: string
        subject: string
        description: string
        owner?: string
        depends_on: string[]
      }
      const name = teamName(context)
      const id = input.task_id ?? `task-${randomUUID()}`
      const task: TeamRuntimeTaskRecord = {
        id,
        subject: input.subject,
        description: input.description,
        status: 'pending',
        owner: input.owner ?? null,
        dependsOn: input.depends_on
      }
      await store.mutateManifest({
        teamName: name,
        workspaceId: context.run.workspaceId,
        mutate: (manifest) => {
          if (manifest.tasks.some((item) => item.id === id))
            throw new RuntimeError('TEAM_TASK_EXISTS')
          if (
            input.depends_on.some(
              (dependency) =>
                dependency === id || !manifest.tasks.some((item) => item.id === dependency)
            )
          )
            throw new RuntimeError('TEAM_TASK_DEPENDENCY_INVALID')
          manifest.tasks.push(task)
        }
      })
      return JSON.stringify({ success: true, task })
    }
  }
}

function taskUpdateTool(): ToolDefinition {
  return {
    name: 'TeamTaskUpdate',
    description: 'Update a team task status, owner, report, or dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, maxLength: 256 },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'failed', 'cancelled']
        },
        subject: { type: 'string', maxLength: 256 },
        description: { type: 'string', maxLength: 8192 },
        owner: { type: ['string', 'null'] },
        report: { type: 'string', maxLength: 32768 },
        depends_on: { type: 'array', items: { type: 'string', maxLength: 256 }, maxItems: 32 }
      },
      required: ['task_id'],
      additionalProperties: false
    },
    effect: 'write',
    validate: (value) => {
      const input = inputRecord(value)
      const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : ''
      if (!taskId) throw new RuntimeError('INVALID_TOOL_INPUT')
      const patch: Record<string, unknown> = { task_id: taskId }
      if (input.status !== undefined) {
        if (
          !['pending', 'in_progress', 'completed', 'failed', 'cancelled'].includes(
            String(input.status)
          )
        )
          throw new RuntimeError('INVALID_TOOL_INPUT')
        patch.status = input.status
      }
      for (const key of ['subject', 'description', 'report']) {
        if (input[key] !== undefined) {
          if (typeof input[key] !== 'string') throw new RuntimeError('INVALID_TOOL_INPUT')
          patch[key] = input[key].trim()
        }
      }
      if (input.owner !== undefined) {
        if (input.owner !== null && typeof input.owner !== 'string')
          throw new RuntimeError('INVALID_TOOL_INPUT')
        patch.owner = input.owner === null ? null : input.owner.trim()
      }
      if (input.depends_on !== undefined) {
        if (
          !Array.isArray(input.depends_on) ||
          input.depends_on.some((item) => typeof item !== 'string')
        )
          throw new RuntimeError('INVALID_TOOL_INPUT')
        patch.depends_on = [...new Set(input.depends_on.map((item) => item.trim()))]
      }
      if (Object.keys(patch).length === 1) throw new RuntimeError('INVALID_TOOL_INPUT')
      return patch
    },
    resources: async (_input, context) => [`team:${teamName(context)}`],
    execute: async (value, context) => {
      const input = value as Record<string, unknown> & { task_id: string }
      const name = teamName(context)
      const dependencies = Array.isArray(input.depends_on)
        ? (input.depends_on as string[])
        : undefined
      let updatedTask: TeamRuntimeTaskRecord | undefined
      await store.mutateManifest({
        teamName: name,
        workspaceId: context.run.workspaceId,
        mutate: (manifest) => {
          const index = manifest.tasks.findIndex((task) => task.id === input.task_id)
          if (index < 0) throw new RuntimeError('TEAM_TASK_NOT_FOUND')
          if (
            dependencies?.some(
              (dependency) =>
                dependency === input.task_id ||
                !manifest.tasks.some((task) => task.id === dependency)
            )
          )
            throw new RuntimeError('TEAM_TASK_DEPENDENCY_INVALID')
          updatedTask = {
            ...manifest.tasks[index],
            ...(typeof input.status === 'string'
              ? { status: input.status as TeamRuntimeTaskStatus }
              : {}),
            ...(typeof input.subject === 'string' ? { subject: input.subject } : {}),
            ...(typeof input.description === 'string' ? { description: input.description } : {}),
            ...(input.owner === null || typeof input.owner === 'string'
              ? { owner: input.owner as string | null }
              : {}),
            ...(typeof input.report === 'string' ? { report: input.report } : {}),
            ...(dependencies ? { dependsOn: dependencies } : {})
          }
          manifest.tasks[index] = updatedTask
        }
      })
      return JSON.stringify({ success: true, task: updatedTask })
    }
  }
}

export function createTeamRuntimeTools(): ToolDefinition[] {
  return [
    teamCreateTool(),
    sendMessageTool(),
    teamStatusTool(),
    teamDeleteTool(),
    taskCreateTool(),
    taskUpdateTool()
  ]
}
