import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({
  onlineDirectoryCalls: 0,
  offlineDirectoryCalls: 0,
  revokeAfter: Infinity
}))

vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceExpiresAt: async () => null,
  loadOfflineWorkspaceIds: async () => {
    state.offlineDirectoryCalls += 1
    return new Set(state.offlineDirectoryCalls > state.revokeAfter ? [] : ['team-cached'])
  },
  loadManagedWorkspaceIds: async () => {
    state.onlineDirectoryCalls += 1
    throw new Error('Network unavailable')
  },
  loadManagedModelResources: async () => {
    throw new Error('Network unavailable')
  }
}))

import { DesktopRuntime } from '../../src/main/runtime/desktop-runtime'

it('keeps local runtime data accessible to an offline-authorized team without online directory', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ola-runtime-offline-team-'))
  const runtime = new DesktopRuntime(join(dataDirectory, 'desktop-runtime.json'))
  try {
    await runtime.start(dataDirectory)
    await expect(runtime.request('run.list', { workspaceId: 'team-cached' })).resolves.toBeDefined()
    await expect(
      runtime.request('run.list', { workspaceId: 'team-revoked' })
    ).rejects.toMatchObject({
      code: 'WORKSPACE_FORBIDDEN'
    })
    expect(state.onlineDirectoryCalls).toBe(0)
  } finally {
    await runtime.stop()
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

it('rejects a team run when offline authorization disappears after transport admission', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ola-runtime-revoked-team-'))
  const runtime = new DesktopRuntime(join(dataDirectory, 'desktop-runtime.json'))
  try {
    await runtime.start(dataDirectory)
    state.offlineDirectoryCalls = 0
    state.revokeAfter = 1
    await expect(
      runtime.request('run.submit', {
        runId: 'revoked-run',
        taskId: 'task',
        requestId: 'request',
        traceId: 'trace',
        sessionId: 'session',
        workspaceId: 'team-cached',
        environmentId: 'local',
        modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
        prompt: 'hello',
        unattended: true
      })
    ).rejects.toMatchObject({ code: 'WORKSPACE_FORBIDDEN' })
    state.revokeAfter = Infinity
    await expect(runtime.request('run.list', { workspaceId: 'team-cached' })).resolves.toEqual([])
  } finally {
    state.revokeAfter = Infinity
    await runtime.stop()
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
