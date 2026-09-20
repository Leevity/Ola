import { randomUUID } from 'node:crypto'
import { getTask, listTasksBySession, createTask, updateTask, deleteTask } from '../db/tasks-dao'
import { RuntimeError } from '../../shared/runtime/contracts'
import type { ToolDefinition } from '../../runtime/tools/tool-executor'

const MAX_TEXT = 64 * 1024
const MAX_ID = 512
const MAX_LINKS = 100

type TaskInput = {
  taskId?: string
  title?: string
  activeForm?: string
  status?: string
  owner?: string
  addBlocks?: string[]
  addBlockedBy?: string[]
  metadata?: Record<string, unknown>
}

function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value as Record<string, unknown>
}

function optionalString(value: unknown, max = MAX_TEXT): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > max) throw new RuntimeError('INVALID_TOOL_INPUT')
  return value
}

function requiredId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id || id.length > MAX_ID) throw new RuntimeError('INVALID_TOOL_INPUT')
  return id
}

function links(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.length > MAX_LINKS ||
    value.some((item) => typeof item !== 'string' || item.length > MAX_ID)
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value as string[]
}

function metadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new RuntimeError('INVALID_TOOL_INPUT')
  }
  if (serialized.length > MAX_TEXT) throw new RuntimeError('INVALID_TOOL_INPUT')
  return value as Record<string, unknown>
}

function taskInput(value: unknown, requireTitle: boolean): TaskInput {
  const item = objectInput(value)
  const title = optionalString(item.title, 1024)
  if (requireTitle && !title?.trim()) throw new RuntimeError('INVALID_TOOL_INPUT')
  const status = optionalString(item.status, 32)
  if (
    status !== undefined &&
    !['pending', 'in_progress', 'in_review', 'blocked', 'completed', 'deleted'].includes(status)
  )
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const owner = item.owner
  if (owner !== undefined && typeof owner !== 'string') throw new RuntimeError('INVALID_TOOL_INPUT')
  const addBlocks = links(item.addBlocks)
  const addBlockedBy = links(item.addBlockedBy)
  const taskMetadata = metadata(item.metadata)
  return {
    ...(item.taskId === undefined ? {} : { taskId: requiredId(item.taskId) }),
    ...(title === undefined ? {} : { title }),
    ...(item.activeForm === undefined ? {} : { activeForm: optionalString(item.activeForm, 1024) }),
    ...(status === undefined ? {} : { status }),
    ...(owner === undefined ? {} : { owner: owner as string }),
    ...(addBlocks === undefined ? {} : { addBlocks }),
    ...(addBlockedBy === undefined ? {} : { addBlockedBy }),
    ...(taskMetadata === undefined ? {} : { metadata: taskMetadata })
  }
}

function taskResource(context: { run: { workspaceId: string; sessionId: string } }): string {
  return `tasks:${context.run.workspaceId}:${context.run.sessionId}`
}

function taskSchema(includeId = false): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      ...(includeId ? { taskId: { type: 'string', maxLength: MAX_ID } } : {}),
      title: { type: 'string', maxLength: 1024 },
      activeForm: { type: 'string', maxLength: 1024 },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'in_review', 'blocked', 'completed', 'deleted']
      },
      owner: { type: 'string', maxLength: MAX_ID },
      addBlocks: {
        type: 'array',
        maxItems: MAX_LINKS,
        items: { type: 'string', maxLength: MAX_ID }
      },
      addBlockedBy: {
        type: 'array',
        maxItems: MAX_LINKS,
        items: { type: 'string', maxLength: MAX_ID }
      },
      metadata: { type: 'object' }
    },
    additionalProperties: false
  }
}

export function createTaskRuntimeTools(): ToolDefinition[] {
  const list: ToolDefinition = {
    name: 'TaskList',
    description: 'List task-board items for the current session.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    effect: 'read',
    validate: (value) => {
      objectInput(value)
      return {}
    },
    resources: async () => [],
    execute: async (_value, context) =>
      listTasksBySession(context.run.sessionId, context.run.workspaceId)
  }
  const get: ToolDefinition = {
    name: 'TaskGet',
    description: 'Get one task-board item for the current session.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', maxLength: MAX_ID } },
      required: ['taskId'],
      additionalProperties: false
    },
    effect: 'read',
    validate: (value) => {
      const input = taskInput(value, false)
      if (!input.taskId) throw new RuntimeError('INVALID_TOOL_INPUT')
      return input
    },
    resources: async () => [],
    execute: async (value, context) => {
      const task = await getTask((value as TaskInput).taskId!, context.run.workspaceId)
      if (!task || task.session_id !== context.run.sessionId)
        throw new RuntimeError('TASK_NOT_FOUND')
      return task
    }
  }
  const create: ToolDefinition = {
    name: 'TaskCreate',
    description: 'Create a task-board item in the current session.',
    inputSchema: taskSchema(),
    effect: 'write',
    validate: (value) => taskInput(value, true),
    resources: async (_value, context) => [taskResource(context)],
    execute: async (value, context) => {
      const input = value as TaskInput
      const existing = await listTasksBySession(context.run.sessionId, context.run.workspaceId)
      const now = Date.now()
      const id = `task-${randomUUID()}`
      await createTask({
        id,
        sessionId: context.run.sessionId,
        workspaceId: context.run.workspaceId,
        subject: input.title!,
        description: input.title!,
        activeForm: input.activeForm,
        status: input.status ?? 'pending',
        owner: input.owner,
        blocks: input.addBlocks,
        blockedBy: input.addBlockedBy,
        metadata: input.metadata,
        sortOrder: existing.length,
        createdAt: now,
        updatedAt: now
      })
      return (
        (await getTask(id, context.run.workspaceId)) ?? {
          id,
          ...input,
          createdAt: now,
          updatedAt: now
        }
      )
    }
  }
  const update: ToolDefinition = {
    name: 'TaskUpdate',
    description: 'Update a task-board item in the current session.',
    inputSchema: taskSchema(true),
    effect: 'write',
    validate: (value) => {
      const input = taskInput(value, false)
      if (!input.taskId || Object.keys(input).length === 1)
        throw new RuntimeError('INVALID_TOOL_INPUT')
      return input
    },
    resources: async (_value, context) => [taskResource(context)],
    execute: async (value, context) => {
      const input = value as TaskInput
      const current = await getTask(input.taskId!, context.run.workspaceId)
      if (!current || current.session_id !== context.run.sessionId)
        throw new RuntimeError('TASK_NOT_FOUND')
      if (input.status === 'deleted') {
        await deleteTask(input.taskId!, context.run.workspaceId)
        return { success: true, deleted: input.taskId }
      }
      const patch = {
        ...(input.title === undefined ? {} : { subject: input.title }),
        ...(input.activeForm === undefined ? {} : { activeForm: input.activeForm }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.owner === undefined ? {} : { owner: input.owner }),
        ...(input.addBlocks === undefined ? {} : { blocks: input.addBlocks }),
        ...(input.addBlockedBy === undefined ? {} : { blockedBy: input.addBlockedBy }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata })
      }
      await updateTask(input.taskId!, context.run.workspaceId, { ...patch, updatedAt: Date.now() })
      return (await getTask(input.taskId!, context.run.workspaceId)) ?? { ...current, ...patch }
    }
  }
  const remove: ToolDefinition = {
    name: 'TaskDelete',
    description: 'Delete a task-board item in the current session.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', maxLength: MAX_ID } },
      required: ['taskId'],
      additionalProperties: false
    },
    effect: 'write',
    validate: (value) => {
      const input = taskInput(value, false)
      if (!input.taskId) throw new RuntimeError('INVALID_TOOL_INPUT')
      return input
    },
    resources: async (_value, context) => [taskResource(context)],
    execute: async (value, context) => {
      const taskId = (value as TaskInput).taskId!
      const current = await getTask(taskId, context.run.workspaceId)
      if (!current || current.session_id !== context.run.sessionId)
        throw new RuntimeError('TASK_NOT_FOUND')
      await deleteTask(taskId, context.run.workspaceId)
      return { success: true, deleted: taskId }
    }
  }
  return [list, get, create, update, remove]
}
