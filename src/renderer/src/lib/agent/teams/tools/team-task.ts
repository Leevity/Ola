import type { ToolHandler } from '../../../tools/tool-types'
import { encodeStructuredToolResult, encodeToolError } from '../../../tools/tool-result-format'
import { getTeamRuntimeSnapshot, updateTeamRuntimeManifest } from '../runtime-client'
import { useTeamStore } from '@renderer/stores/team-store'
import type { TeamTask, TeamTaskStatus } from '../types'

function activeTeam(): string | null {
  return useTeamStore.getState().activeTeam?.name ?? null
}

export const teamTaskCreateTool: ToolHandler = {
  definition: {
    name: 'TeamTaskCreate',
    description: 'Create a persistent task for the active team, with optional dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        subject: { type: 'string' },
        description: { type: 'string' },
        owner: { type: 'string' },
        depends_on: { type: 'array', items: { type: 'string' } }
      },
      required: ['subject', 'description']
    }
  },
  execute: async (input) => {
    const teamName = activeTeam()
    if (!teamName) return encodeToolError('No active team')
    const subject = typeof input.subject === 'string' ? input.subject.trim() : ''
    const description = typeof input.description === 'string' ? input.description.trim() : ''
    if (!subject || !description) return encodeToolError('subject and description are required')
    const dependsOn = Array.isArray(input.depends_on)
      ? [...new Set(input.depends_on.filter((item): item is string => typeof item === 'string'))]
      : []
    try {
      const snapshot = await getTeamRuntimeSnapshot({ teamName, limit: 50 })
      if (!snapshot) return encodeToolError(`Team "${teamName}" does not exist`)
      const id =
        typeof input.task_id === 'string' && input.task_id.trim()
          ? input.task_id.trim()
          : `task-${crypto.randomUUID()}`
      if (snapshot.team.tasks.some((task) => task.id === id))
        return encodeToolError('Task already exists')
      if (
        dependsOn.some(
          (dependency) =>
            dependency === id || !snapshot.team.tasks.some((task) => task.id === dependency)
        )
      ) {
        return encodeToolError('Task dependency does not exist')
      }
      const task: TeamTask = {
        id,
        subject,
        description,
        status: 'pending',
        owner: typeof input.owner === 'string' && input.owner.trim() ? input.owner.trim() : null,
        dependsOn
      }
      await updateTeamRuntimeManifest({
        teamName,
        patch: { tasks: [...snapshot.team.tasks, task] }
      })
      return encodeStructuredToolResult({ success: true, task })
    } catch (error) {
      return encodeToolError(error instanceof Error ? error.message : String(error))
    }
  },
  requiresApproval: () => false
}

export const teamTaskUpdateTool: ToolHandler = {
  definition: {
    name: 'TeamTaskUpdate',
    description: 'Update a persistent task in the active team.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'failed', 'cancelled']
        },
        subject: { type: 'string' },
        description: { type: 'string' },
        owner: { type: ['string', 'null'] },
        report: { type: 'string' },
        depends_on: { type: 'array', items: { type: 'string' } }
      },
      required: ['task_id']
    }
  },
  execute: async (input) => {
    const teamName = activeTeam()
    if (!teamName) return encodeToolError('No active team')
    const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : ''
    if (!taskId) return encodeToolError('task_id is required')
    try {
      const snapshot = await getTeamRuntimeSnapshot({ teamName, limit: 50 })
      if (!snapshot) return encodeToolError(`Team "${teamName}" does not exist`)
      const current = snapshot.team.tasks.find((task) => task.id === taskId)
      if (!current) return encodeToolError('Task not found')
      const dependsOn = !Array.isArray(input.depends_on)
        ? undefined
        : [...new Set(input.depends_on.filter((item): item is string => typeof item === 'string'))]
      if (
        dependsOn?.some(
          (dependency) =>
            dependency === taskId || !snapshot.team.tasks.some((task) => task.id === dependency)
        )
      ) {
        return encodeToolError('Task dependency does not exist')
      }
      const task: TeamTask = {
        ...current,
        ...(typeof input.status === 'string' ? { status: input.status as TeamTaskStatus } : {}),
        ...(typeof input.subject === 'string' ? { subject: input.subject.trim() } : {}),
        ...(typeof input.description === 'string' ? { description: input.description.trim() } : {}),
        ...(input.owner === null || typeof input.owner === 'string'
          ? { owner: input.owner === null ? null : input.owner.trim() }
          : {}),
        ...(typeof input.report === 'string' ? { report: input.report.trim() } : {}),
        ...(dependsOn ? { dependsOn } : {})
      }
      const tasks = snapshot.team.tasks.map((item) => (item.id === taskId ? task : item))
      await updateTeamRuntimeManifest({ teamName, patch: { tasks } })
      return encodeStructuredToolResult({ success: true, task })
    } catch (error) {
      return encodeToolError(error instanceof Error ? error.message : String(error))
    }
  },
  requiresApproval: () => false
}
