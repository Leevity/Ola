import type { TaskItem } from '@renderer/stores/task-store'
import { toolRegistry } from '../agent/tool-registry'
import { encodeStructuredToolResult, encodeToolError } from './tool-result-format'
import type { ToolHandler } from './tool-types'
import { useTaskStore, type TaskStatus } from '@renderer/stores/task-store'

function sessionIdFor(ctx: Parameters<ToolHandler['execute']>[1]): string | null {
  const sessionId = ctx.sessionId?.trim()
  return sessionId || null
}

// ── TaskCreate ──

const taskCreateHandler: ToolHandler = {
  definition: {
    name: 'TaskCreate',
    description:
      'Create a task for the current session. Use this to track progress on complex multi-step work. Tasks are displayed in the Steps panel.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description:
            'A detailed task title with enough context that no separate description is needed'
        },
        activeForm: {
          type: 'string',
          description:
            'Present continuous form shown in spinner when in_progress (e.g., "Running tests")'
        },
        metadata: {
          type: 'object',
          description: 'Arbitrary metadata to attach to the task'
        }
      },
      required: ['title']
    }
  },
  execute: async (input, ctx) => {
    const sessionId = sessionIdFor(ctx)
    if (!sessionId) return encodeToolError('A session is required to create a task')
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (!title) return encodeToolError('title is required')
    const now = Date.now()
    let task: TaskItem
    try {
      task = await useTaskStore.getState().addTask({
        id: crypto.randomUUID(),
        sessionId,
        subject: title,
        description: title,
        ...(typeof input.activeForm === 'string' && input.activeForm.trim()
          ? { activeForm: input.activeForm.trim() }
          : {}),
        status: 'pending',
        owner: null,
        blocks: [],
        blockedBy: [],
        ...(input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
          ? { metadata: input.metadata as Record<string, unknown> }
          : {}),
        createdAt: now,
        updatedAt: now
      })
    } catch (error) {
      return encodeToolError(`Task creation failed: ${String(error)}`)
    }
    return encodeStructuredToolResult({ task: { ...task } })
  },
  requiresApproval: () => false
}

// ── TaskGet ──

const taskGetHandler: ToolHandler = {
  definition: {
    name: 'TaskGet',
    description:
      'Retrieve a task by its ID to inspect its title, status, ownership, and dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The ID of the task to retrieve'
        }
      },
      required: ['taskId']
    }
  },
  execute: async (input, ctx) => {
    const sessionId = sessionIdFor(ctx)
    if (!sessionId) return encodeToolError('A session is required to read a task')
    const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : ''
    if (!taskId) return encodeToolError('taskId is required')
    const task = useTaskStore.getState().getTask(taskId)
    if (!task || task.sessionId !== sessionId) return encodeToolError('Task not found')
    return encodeStructuredToolResult({ task: { ...task } })
  },
  requiresApproval: () => false
}

// ── TaskUpdate ──

const taskUpdateHandler: ToolHandler = {
  definition: {
    name: 'TaskUpdate',
    description:
      'Update a task: change status, title, owner, or manage dependencies. Set status to "deleted" to permanently remove a task.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The ID of the task to update' },
        title: {
          type: 'string',
          description:
            'New detailed title for the task. Include enough detail that no description is needed.'
        },
        activeForm: {
          type: 'string',
          description:
            'Present continuous form shown in spinner when in_progress (e.g., "Running tests")'
        },
        status: {
          type: 'string',
          enum: [
            'pending',
            'in_progress',
            'in_review',
            'blocked',
            'completed',
            'failed',
            'cancelled',
            'deleted'
          ],
          description: 'New status for the task'
        },
        addBlocks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task IDs that this task blocks'
        },
        addBlockedBy: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task IDs that block this task'
        },
        owner: { type: 'string', description: 'New owner for the task' },
        metadata: {
          type: 'object',
          description: 'Metadata keys to merge into the task. Set a key to null to delete it.'
        }
      },
      required: ['taskId']
    }
  },
  execute: async (input, ctx) => {
    const sessionId = sessionIdFor(ctx)
    if (!sessionId) return encodeToolError('A session is required to update a task')
    const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : ''
    if (!taskId) return encodeToolError('taskId is required')
    const current = useTaskStore.getState().getTask(taskId)
    if (!current || current.sessionId !== sessionId) return encodeToolError('Task not found')
    if (input.status === 'deleted') {
      try {
        if (!(await useTaskStore.getState().deleteTask(taskId))) {
          return encodeToolError('Task was not deleted')
        }
      } catch (error) {
        return encodeToolError(`Task deletion failed: ${String(error)}`)
      }
      return encodeStructuredToolResult({ success: true, deleted: taskId })
    }
    const statusValue = input.status
    if (
      statusValue !== undefined &&
      statusValue !== 'pending' &&
      statusValue !== 'in_progress' &&
      statusValue !== 'in_review' &&
      statusValue !== 'blocked' &&
      statusValue !== 'completed' &&
      statusValue !== 'failed' &&
      statusValue !== 'cancelled'
    )
      return encodeToolError(`Unsupported task status: ${String(statusValue)}`)
    const status = statusValue as TaskStatus | undefined
    const patch = {
      ...(typeof input.title === 'string' ? { subject: input.title.trim() } : {}),
      ...(typeof input.activeForm === 'string' ? { activeForm: input.activeForm.trim() } : {}),
      ...(status ? { status } : {}),
      ...(typeof input.owner === 'string' ? { owner: input.owner } : {}),
      ...(Array.isArray(input.addBlocks)
        ? { blocks: input.addBlocks.filter((value): value is string => typeof value === 'string') }
        : {}),
      ...(Array.isArray(input.addBlockedBy)
        ? {
            blockedBy: input.addBlockedBy.filter(
              (value): value is string => typeof value === 'string'
            )
          }
        : {}),
      ...(input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
        ? { metadata: input.metadata as Record<string, unknown> }
        : {})
    }
    let task: TaskItem | undefined
    try {
      task = await useTaskStore.getState().updateTask(taskId, patch)
    } catch (error) {
      return encodeToolError(`Task update failed: ${String(error)}`)
    }
    return task
      ? encodeStructuredToolResult({ task: { ...task } })
      : encodeToolError('Task was not updated')
  },
  requiresApproval: () => false
}

// ── TaskList ──

const taskListHandler: ToolHandler = {
  definition: {
    name: 'TaskList',
    description:
      'List all tasks in the current session with their detailed titles, status, owner, and dependencies.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  execute: async (_input, ctx) => {
    const sessionId = sessionIdFor(ctx)
    if (!sessionId) return encodeToolError('A session is required to list tasks')
    const tasks = useTaskStore.getState().getTasksBySession(sessionId)
    return encodeStructuredToolResult({ tasks: tasks.map((task) => ({ ...task })) })
  },
  requiresApproval: () => false
}

// ── Registration ──

export function registerTaskTools(): void {
  toolRegistry.register(taskCreateHandler)
  toolRegistry.register(taskGetHandler)
  toolRegistry.register(taskUpdateHandler)
  toolRegistry.register(taskListHandler)
}
