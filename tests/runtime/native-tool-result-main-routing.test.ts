import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  workspaceId: 'team-a',
  allowed: true,
  sessionReads: 0,
  nativeReads: 0,
  canaryResult: [{ toolUseId: 'tool-a' }] as unknown[] | undefined,
  revokeDuringCanary: false,
  moveDuringCanary: false
}))

vi.mock('../../src/main/lib/native-worker', () => ({
  getNativeWorker: () => ({
    request: async (method: string) => {
      if (method !== 'agent/tool-results-lookup') throw new Error(`unexpected ${method}`)
      state.nativeReads++
      return [{ toolUseId: 'native-tool' }]
    }
  })
}))
vi.mock('../../src/main/db/sessions-dao', () => ({
  getSession: async () => {
    state.sessionReads++
    return { workspace_id: state.workspaceId }
  }
}))
vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: async () => new Set(state.allowed ? ['team-a'] : [])
}))
vi.mock('../../src/main/db/legacy-read-canary', () => ({
  canaryLookupRuntimeToolResults: async () => {
    if (state.revokeDuringCanary) state.allowed = false
    if (state.moveDuringCanary) state.workspaceId = 'team-b'
    return state.canaryResult
  }
}))

import { NativeAgentRuntimeManager } from '../../src/main/ipc/native-agent-runtime'

beforeEach(() => {
  state.workspaceId = 'team-a'
  state.allowed = true
  state.sessionReads = 0
  state.nativeReads = 0
  state.canaryResult = [{ toolUseId: 'tool-a' }]
  state.revokeDuringCanary = false
  state.moveDuringCanary = false
})

function manager(): NativeAgentRuntimeManager {
  const instance = new NativeAgentRuntimeManager()
  vi.spyOn(instance, 'ensureStarted').mockResolvedValue(true)
  return instance
}

it('uses TS results after verifying the session twice without invoking Native lookup', async () => {
  await expect(manager().lookupToolResults('session-a', ['tool-a'])).resolves.toEqual([
    { toolUseId: 'tool-a' }
  ])
  expect(state.sessionReads).toBe(2)
  expect(state.nativeReads).toBe(0)
})

it('falls back to Native when the TS reader is unavailable', async () => {
  state.canaryResult = undefined
  await expect(manager().lookupToolResults('session-a', ['tool-a'])).resolves.toEqual([
    { toolUseId: 'native-tool' }
  ])
  expect(state.nativeReads).toBe(1)
  expect(state.sessionReads).toBe(2)
})

it('does not return fetched results after team authorization is revoked', async () => {
  state.revokeDuringCanary = true
  await expect(manager().lookupToolResults('session-a', ['tool-a'])).rejects.toThrow(
    'Tool result workspace is not available'
  )
})

it('does not return fetched results after the session moves to another workspace', async () => {
  state.moveDuringCanary = true
  await expect(manager().lookupToolResults('session-a', ['tool-a'])).rejects.toThrow(
    'Tool result session workspace changed during lookup'
  )
})
