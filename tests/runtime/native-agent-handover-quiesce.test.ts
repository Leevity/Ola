import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  running: false,
  active: [] as Array<{ runId: string }>,
  requests: [] as string[],
  startGate: null as Promise<void> | null
}))

vi.mock('../../src/main/lib/native-worker', () => ({
  getNativeWorker: () => ({
    get isRunning() {
      return state.running
    },
    ensureStarted: async () => {
      await state.startGate
      state.running = true
    },
    request: async (method: string) => {
      state.requests.push(method)
      if (method === 'agent/active-runs') return state.active
      if (method === 'agent/run') return { started: true, runId: 'run-a' }
      return { success: true }
    },
    onRawEvent: () => () => undefined,
    onEvent: () => () => undefined,
    onLifecycle: () => () => undefined
  })
}))

vi.mock('../../src/main/db/sessions-dao', () => ({ getSession: async () => null }))
vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: async () => new Set()
}))

import { NativeAgentRuntimeManager } from '../../src/main/ipc/native-agent-runtime'

it('parks new Native Agent submissions after handover quiesce', async () => {
  state.running = false
  state.active = []
  state.requests = []
  state.startGate = null
  const manager = new NativeAgentRuntimeManager()
  await manager.quiesceForHandover()
  await expect(manager.request('agent/run', {})).rejects.toThrow('NATIVE_AGENT_HANDOVER_QUIESCED')
  expect(state.requests).toEqual([])
})

it('refuses handover when the Native Worker reports an active Agent run', async () => {
  state.running = true
  state.active = [{ runId: 'running' }]
  state.requests = []
  state.startGate = null
  const manager = new NativeAgentRuntimeManager()
  await expect(manager.quiesceForHandover()).rejects.toThrow(
    'NATIVE_AGENT_RUNS_ACTIVE_DURING_HANDOVER'
  )
  expect(state.requests).toEqual(['agent/active-runs'])
  await expect(manager.request('agent/run', {})).rejects.toThrow('NATIVE_AGENT_HANDOVER_QUIESCED')
})

it('does not admit a run that was waiting for Worker startup when quiesce began', async () => {
  state.running = false
  state.active = []
  state.requests = []
  let release!: () => void
  state.startGate = new Promise<void>((resolve) => {
    release = resolve
  })
  const manager = new NativeAgentRuntimeManager()
  const pending = manager.request('agent/run', {})
  await expect(manager.quiesceForHandover()).rejects.toThrow(
    'NATIVE_AGENT_RUNS_ACTIVE_DURING_HANDOVER'
  )
  release()
  await expect(pending).rejects.toThrow('NATIVE_AGENT_HANDOVER_QUIESCED')
  expect(state.requests).not.toContain('agent/run')
  state.startGate = null
})

it('closes Native Agent admission for the duration of a workspace switch', async () => {
  state.running = false
  state.active = []
  state.requests = []
  state.startGate = null
  const manager = new NativeAgentRuntimeManager()
  const releaseSwitch = manager.beginWorkspaceSwitch()
  await expect(manager.request('agent/run', {})).rejects.toThrow('WORKSPACE_BUSY_AGENT')
  expect(state.requests).not.toContain('agent/run')
  expect(() => manager.beginWorkspaceSwitch()).toThrow('WORKSPACE_BUSY_AGENT')
  releaseSwitch()
  releaseSwitch()
  await expect(manager.request('agent/run', {})).resolves.toMatchObject({ started: true })
  expect(() => manager.beginWorkspaceSwitch()).toThrow('WORKSPACE_BUSY_AGENT')
})

it('does not admit a run that was waiting for Worker startup when a switch began', async () => {
  state.running = false
  state.active = []
  state.requests = []
  let releaseStart!: () => void
  state.startGate = new Promise<void>((resolve) => {
    releaseStart = resolve
  })
  const manager = new NativeAgentRuntimeManager()
  const pending = manager.request('agent/run', {})
  expect(() => manager.beginWorkspaceSwitch()).toThrow('WORKSPACE_BUSY_AGENT')
  releaseStart()
  await expect(pending).resolves.toMatchObject({ started: true })
  state.startGate = null
})
