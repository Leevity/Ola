import { describe, expect, it, vi } from 'vitest'
import { RuntimeError } from '../../src/shared/runtime/contracts'
import type { ToolContext } from '../../src/runtime/tools/tool-executor'

const cron = vi.hoisted(() => ({
  add: vi.fn(async (args: unknown) => ({ success: true, args })),
  update: vi.fn(async (args: unknown) => ({ success: true, args })),
  remove: vi.fn(async (args: unknown) => ({ success: true, args })),
  del: vi.fn(async (args: unknown) => ({ success: true, args })),
  list: vi.fn(async (args: unknown) => ({ success: true, args }))
}))

vi.mock('../../src/main/ipc/cron-handlers', () => ({
  handleCronAdd: cron.add,
  handleCronUpdate: cron.update,
  handleCronRemove: cron.remove,
  handleCronDelete: cron.del,
  handleCronList: cron.list
}))

import { createCronRuntimeTools } from '../../src/main/runtime/cron-runtime-tools'

const context: ToolContext = {
  run: {
    runId: 'run',
    taskId: 'task',
    requestId: 'request',
    traceId: 'trace',
    sessionId: 'session-current',
    workspaceId: 'workspace-current',
    environmentId: 'local',
    modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
    prompt: 'schedule',
    toolNames: ['CronAdd'],
    unattended: false,
    workingDirectory: 'C:\\projects\\current'
  },
  signal: new AbortController().signal
}

describe('Main-owned Cron runtime tools', () => {
  it('binds created jobs to the active workspace, session, and working directory', async () => {
    const add = createCronRuntimeTools().find((tool) => tool.name === 'CronAdd')!
    const input = add.validate({
      name: 'reminder',
      schedule: { kind: 'at', at: '+10m' },
      prompt: 'Notify me',
      workingFolder: 'C:\\outside'
    })
    await add.execute(input, context)
    const args = cron.add.mock.calls.at(-1)?.[0] as {
      workspaceId: string
      sessionId: string
      workingFolder: string
      schedule: { at: number }
    }
    expect(args.workspaceId).toBe('workspace-current')
    expect(args.sessionId).toBe('session-current')
    expect(args.workingFolder).toBe('C:\\projects\\current')
    expect(args.schedule.at).toBeGreaterThan(Date.now())
    expect(args.schedule.at).not.toBe('+10m')
  })

  it('rejects unknown fields and limits job updates to supported safe fields', () => {
    const tools = createCronRuntimeTools()
    const add = tools.find((tool) => tool.name === 'CronAdd')!
    const update = tools.find((tool) => tool.name === 'CronUpdate')!
    expect(() =>
      add.validate({
        name: 'x',
        schedule: { kind: 'every', every: 60_000 },
        prompt: 'x',
        workspaceId: 'other'
      })
    ).toThrowError(RuntimeError)
    expect(() =>
      update.validate({ jobId: 'cron-1', patch: { workingFolder: 'C:\\outside' } })
    ).toThrowError(RuntimeError)
  })

  it('passes workspace scope to update, delete, and list handlers', async () => {
    const tools = createCronRuntimeTools()
    const update = tools.find((tool) => tool.name === 'CronUpdate')!
    const del = tools.find((tool) => tool.name === 'CronDelete')!
    const list = tools.find((tool) => tool.name === 'CronList')!
    await update.execute(update.validate({ jobId: 'cron-1', patch: { enabled: false } }), context)
    await del.execute(del.validate({ jobId: 'cron-1' }), context)
    await list.execute(list.validate({}), context)
    expect(cron.update.mock.calls.at(-1)?.[0]).toMatchObject({ workspaceId: 'workspace-current' })
    expect(cron.del.mock.calls.at(-1)?.[0]).toMatchObject({ workspaceId: 'workspace-current' })
    expect(cron.list.mock.calls.at(-1)?.[0]).toMatchObject({
      workspaceId: 'workspace-current',
      sessionId: 'session-current'
    })
  })
})
