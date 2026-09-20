import { beforeEach, expect, it, vi } from 'vitest'
import { decode, encode } from '@msgpack/msgpack'

const state = vi.hoisted(() => {
  const repository = {
    submitRuntimeJob: vi.fn(async (input: unknown) => ({
      accepted: true,
      duplicate: false,
      job: input
    })),
    runtimeJob: vi.fn(async () => null),
    runtimeJobs: vi.fn(async () => []),
    setRuntimeJobState: vi.fn(async () => null),
    cancelRuntimeJob: vi.fn(async () => null),
    runtimeJobEvents: vi.fn(async () => []),
    reapStaleRuntimeJobs: vi.fn(async () => ({ reaped: 0, cutoffAt: 0 }))
  }
  return {
    handlers: new Map<string, (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>>(),
    repository,
    window: {}
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>
    ) => {
      state.handlers.set(channel, handler)
    }
  }
}))
vi.mock('../../src/main/db/business-write-canary', () => ({
  businessWriteCanary: () => state.repository
}))
vi.mock('../../src/main/window-ipc', () => ({
  getTrustedWorkspaceRegistrationWindow: () => state.window,
  getRegisteredWindowWorkspace: () => 'team-a'
}))
vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: async () => new Set(['team-a'])
}))

import { registerRuntimeJobHandlers } from '../../src/main/ipc/runtime-job-handlers'

async function call<T>(channel: string, args: unknown, event: unknown = {}): Promise<T> {
  const handler = state.handlers.get(`${channel}:msgpack`)
  if (!handler) throw new Error(`missing handler: ${channel}`)
  return decode(await handler(event, encode(args))) as T
}

beforeEach(() => {
  state.handlers.clear()
  for (const fn of Object.values(state.repository)) fn.mockClear()
  registerRuntimeJobHandlers()
})

it('routes runtime job lifecycle operations to the TS BusinessRepository', async () => {
  const input = {
    jobId: 'job-1',
    workspaceId: 'team-a',
    method: 'agent.run',
    paramsJson: '{}',
    createdAt: 1
  }
  await expect(call('runtime:jobs-submit', input)).resolves.toMatchObject({ accepted: true })
  await expect(call('runtime:jobs-list', { workspaceId: 'team-a', limit: 20 })).resolves.toEqual([])
  await expect(
    call('runtime:jobs-state', {
      workspaceId: 'team-a',
      jobId: 'job-1',
      state: 'running',
      updatedAt: 2
    })
  ).resolves.toBeNull()
  await expect(
    call('runtime:jobs-cancel', { workspaceId: 'team-a', jobId: 'job-1', updatedAt: 3 })
  ).resolves.toBeNull()
  await expect(
    call('runtime:jobs-events', { workspaceId: 'team-a', jobId: 'job-1', afterSeq: 0 })
  ).resolves.toEqual([])
  await expect(call('runtime:jobs-reap-stale', { now: 10 })).resolves.toMatchObject({ reaped: 0 })
  expect(state.repository.submitRuntimeJob).toHaveBeenCalledWith(input)
  expect(state.repository.cancelRuntimeJob).toHaveBeenCalledWith('job-1', 'team-a', 3)
})

it('rejects runtime job requests that cross the registered workspace', async () => {
  await expect(call('runtime:jobs-list', { workspaceId: 'team-b' })).rejects.toThrow(
    'db-workspace-unavailable'
  )
})
