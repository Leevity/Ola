import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const db = vi.hoisted(() => ({
  getPlanBySession: vi.fn(),
  createPlan: vi.fn(),
  updatePlan: vi.fn()
}))

vi.mock('../../src/main/db/plans-dao', () => db)

import { createPlanRuntimeTools } from '../../src/main/runtime/plan-runtime-tools'
import type { ToolContext } from '../../src/runtime/tools/tool-executor'

let workingDirectory = ''

function makeContext(): ToolContext {
  return {
    run: {
      runId: 'run-a',
      taskId: 'task-a',
      requestId: 'request-a',
      traceId: 'trace-a',
      sessionId: 'session-a',
      workspaceId: 'workspace-a',
      environmentId: 'local',
      modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
      prompt: 'test',
      unattended: false,
      workingDirectory
    },
    signal: new AbortController().signal
  }
}

describe('Main TS plan runtime tools', () => {
  beforeEach(async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'ola-plan-runtime-'))
    vi.resetAllMocks()
    db.getPlanBySession.mockResolvedValue(undefined)
    db.createPlan.mockResolvedValue(undefined)
    db.updatePlan.mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await rm(workingDirectory, { recursive: true, force: true })
  })

  it('creates a workspace-bound drafting plan and reuses an active one', async () => {
    const enter = createPlanRuntimeTools()[0]
    const created = {
      id: 'plan-a',
      session_id: 'session-a',
      workspace_id: 'workspace-a',
      title: 'Ship it',
      status: 'drafting',
      file_path: join(workingDirectory, '.plan', 'plan-a.md')
    }
    await mkdirPlanFile(created.file_path)
    db.getPlanBySession.mockResolvedValueOnce(undefined).mockResolvedValueOnce(created)
    const input = enter.validate({ reason: 'Ship it' })
    await expect(enter.execute(input, makeContext())).resolves.toEqual({
      plan: expect.objectContaining({ sessionId: 'session-a', workspaceId: 'workspace-a' }),
      reused: false
    })
    expect(db.createPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-a',
        workspaceId: 'workspace-a',
        title: 'Ship it',
        filePath: expect.stringContaining(join('.plan', ''))
      })
    )

    db.getPlanBySession.mockResolvedValue(created)
    await expect(enter.execute(input, makeContext())).resolves.toEqual({
      plan: expect.objectContaining({ sessionId: 'session-a' }),
      reused: true
    })
  })

  it('moves a written plan into review and rejects empty plans', async () => {
    const exit = createPlanRuntimeTools()[1]
    const plan = {
      id: 'plan-a',
      file_path: join(workingDirectory, '.plan', 'plan-a.md'),
      content: null,
      status: 'drafting'
    }
    await mkdirPlanFile(plan.file_path)
    db.getPlanBySession.mockResolvedValueOnce(plan).mockResolvedValueOnce({
      ...plan,
      status: 'awaiting_review'
    })
    await writeFile(plan.file_path, '# Final plan\n\nShip it safely.\n')
    await expect(exit.execute(exit.validate({}), makeContext())).resolves.toEqual({
      plan: expect.objectContaining({ status: 'awaiting_review', filePath: plan.file_path }),
      awaitingUserReview: true
    })
    expect(db.updatePlan).toHaveBeenCalledWith(
      'plan-a',
      'workspace-a',
      expect.objectContaining({ status: 'awaiting_review' })
    )

    db.getPlanBySession.mockResolvedValue({ ...plan, file_path: null })
    await expect(exit.execute({}, makeContext())).rejects.toThrow('PLAN_CONTENT_REQUIRED')
  })
})

async function mkdirPlanFile(filePath: string): Promise<void> {
  await mkdir(join(filePath, '..'), { recursive: true })
}
