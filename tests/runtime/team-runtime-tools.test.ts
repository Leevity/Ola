import { describe, expect, it, vi } from 'vitest'
import type { RunSpec } from '../../src/shared/runtime/contracts'
import type { ToolContext } from '../../src/runtime/tools/tool-executor'

const teamState = vi.hoisted(() => ({
  tasks: [] as Array<Record<string, unknown>>
}))

vi.mock('../../src/main/teams/team-runtime-store', () => ({
  TeamRuntimeStore: class {
    async snapshot(): Promise<{ team: { tasks: Array<Record<string, unknown>> } }> {
      return { team: { tasks: teamState.tasks } }
    }

    async updateManifestPatch(input: {
      patch: { tasks?: Array<Record<string, unknown>> }
    }): Promise<{ success: true }> {
      teamState.tasks = input.patch.tasks ?? teamState.tasks
      return { success: true }
    }

    async mutateManifest(input: {
      mutate: (manifest: { tasks: Array<Record<string, unknown>> }) => void
    }): Promise<void> {
      const manifest = { tasks: teamState.tasks }
      input.mutate(manifest)
      teamState.tasks = manifest.tasks
    }
  }
}))

import { createTeamRuntimeTools } from '../../src/main/runtime/team-runtime-tools'

function context(): ToolContext {
  const run: RunSpec = {
    runId: 'run-1',
    taskId: 'task-1',
    requestId: 'request-1',
    traceId: 'trace-1',
    sessionId: 'session-1',
    workspaceId: 'local-personal',
    environmentId: 'local',
    modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
    prompt: 'team task test',
    unattended: false,
    teamContext: { teamName: 'test-team', memberName: 'lead' }
  }
  return { run, signal: new AbortController().signal }
}

describe('TS team task tools', () => {
  it('creates a task and updates its durable status/report', async () => {
    teamState.tasks = []
    const tools = createTeamRuntimeTools()
    const create = tools.find((tool) => tool.name === 'TeamTaskCreate')!
    const update = tools.find((tool) => tool.name === 'TeamTaskUpdate')!

    const created = JSON.parse(
      (await create.execute(
        create.validate({ subject: 'Implement worker', description: 'Move the worker to TS' }),
        context()
      )) as string
    )
    const taskId = created.task.id as string
    expect(created).toMatchObject({ success: true, task: { status: 'pending', owner: null } })

    const updated = JSON.parse(
      (await update.execute(
        update.validate({ task_id: taskId, status: 'completed', report: 'Verified' }),
        context()
      )) as string
    )
    expect(updated).toMatchObject({
      success: true,
      task: { id: taskId, status: 'completed', report: 'Verified' }
    })
  })

  it('rejects dependencies that are not existing team tasks', async () => {
    teamState.tasks = []
    const create = createTeamRuntimeTools().find((tool) => tool.name === 'TeamTaskCreate')!
    await expect(
      create.execute(
        create.validate({
          subject: 'Blocked task',
          description: 'Must not be persisted',
          depends_on: ['missing-task']
        }),
        context()
      )
    ).rejects.toThrow('TEAM_TASK_DEPENDENCY_INVALID')
    expect(teamState.tasks).toHaveLength(0)
  })
})
