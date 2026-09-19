import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  activeWorkspaceId: 'local-personal',
  availableWorkspaceIds: ['local-personal', 'team-a', 'team-b'],
  invocations: [] as string[],
  releases: 0,
  desktopFlowResponse: null as Promise<unknown> | null,
  runtimeAvailable: false,
  runtimeSwitchResponse: null as Promise<unknown> | null,
  runtimeSwitchCalls: 0
}))

vi.mock('../../src/renderer/src/stores/workspace-store', () => ({
  useWorkspaceStore: {
    getState: () => ({
      activeWorkspaceId: state.activeWorkspaceId,
      getWorkspaces: () => state.availableWorkspaceIds.map((id) => ({ id })),
      setActiveWorkspace: (id: string) => {
        state.activeWorkspaceId = id
      }
    })
  }
}))
vi.mock('../../src/renderer/src/stores/agent-store', () => ({
  useAgentStore: {
    getState: () => ({
      isRunning: false,
      runningSessions: {},
      runningSubAgentSessionIdsSig: '',
      backgroundProcesses: {},
      sessionBackgroundProcessSummaries: {}
    })
  }
}))
vi.mock('../../src/renderer/src/stores/chat-store', () => ({
  useChatStore: {
    getState: () => ({
      streamingMessages: {},
      setActiveSession: () => undefined,
      setActiveProject: () => undefined,
      setActiveProjectHome: () => undefined
    })
  }
}))
vi.mock('../../src/renderer/src/stores/cron-store', () => ({
  useCronStore: { getState: () => ({ jobs: [] }) }
}))
vi.mock('../../src/renderer/src/stores/draw-store', () => ({
  getActiveDrawRunIds: () => new Set(),
  useDrawStore: { getState: () => ({ commitRuns: () => undefined }) }
}))
vi.mock('../../src/renderer/src/stores/team-store', () => ({
  useTeamStore: { getState: () => ({ activeTeam: null }) }
}))
vi.mock('../../src/renderer/src/stores/ssh-store', () => ({
  useSshStore: {
    getState: () => ({
      sessions: {},
      sftpConnections: {},
      uploadTasks: {},
      transferTasks: {},
      resetForWorkspace: () => undefined,
      loadAll: () => Promise.resolve()
    })
  }
}))
vi.mock('../../src/renderer/src/stores/channel-store', () => ({
  useChannelStore: {
    getState: () => ({
      resetForWorkspace: () => undefined,
      loadChannels: () => Promise.resolve()
    })
  }
}))
vi.mock('../../src/renderer/src/stores/ui-store', () => ({
  useUIStore: {
    getState: () => ({
      saveWorkspaceLayout: () => undefined,
      restoreWorkspaceLayout: () => undefined,
      navigateToHome: () => undefined
    })
  }
}))
vi.mock('../../src/renderer/src/lib/ipc/ts-runtime-bridge', () => ({
  isTsRuntimeAvailable: async () => state.runtimeAvailable,
  requestTsRuntimeWorkspaceSwitch: async () => {
    state.runtimeSwitchCalls++
    return await state.runtimeSwitchResponse
  }
}))
vi.mock('../../src/renderer/src/lib/ipc/ipc-client', () => ({
  ipcClient: {
    invoke: (channel: string) => {
      state.invocations.push(channel)
      if (channel === 'desktop-flow:activity' && state.desktopFlowResponse)
        return state.desktopFlowResponse
      return Promise.resolve({ busy: false })
    }
  }
}))
vi.mock('../../src/renderer/src/lib/agent/runtime-reattach', () => ({
  reattachActiveTsRuntimeRuns: async () => undefined
}))
vi.mock('../../src/renderer/src/lib/channel/channel-task-activity', () => ({
  beginChannelTaskWorkspaceSwitch: () => () => {
    state.releases++
  }
}))

beforeEach(() => {
  state.activeWorkspaceId = 'local-personal'
  state.availableWorkspaceIds = ['local-personal', 'team-a', 'team-b']
  state.invocations.length = 0
  state.releases = 0
  state.desktopFlowResponse = null
  state.runtimeAvailable = false
  state.runtimeSwitchResponse = null
  state.runtimeSwitchCalls = 0
})

it('serializes concurrent switches and releases the guard after completion', async () => {
  let releaseDesktopFlow: ((value: unknown) => void) | undefined
  state.desktopFlowResponse = new Promise((resolve) => {
    releaseDesktopFlow = resolve
  })
  const { switchWorkspace } = await import('../../src/renderer/src/lib/switch-workspace')
  const first = switchWorkspace('team-a')
  await vi.waitFor(() => expect(state.invocations).toContain('desktop-flow:activity'))
  await expect(switchWorkspace('team-b')).resolves.toBe(false)
  expect(state.invocations).toHaveLength(1)
  releaseDesktopFlow?.({ busy: false })
  await expect(first).resolves.toBe(true)
  expect(state.activeWorkspaceId).toBe('team-a')
  expect(state.releases).toBe(1)

  state.desktopFlowResponse = null
  await expect(switchWorkspace('team-b')).resolves.toBe(true)
  expect(state.activeWorkspaceId).toBe('team-b')
  expect(state.releases).toBe(2)
})

it('rejects a workspace revoked during preflight and permits a later valid retry', async () => {
  let releaseDesktopFlow: ((value: unknown) => void) | undefined
  state.desktopFlowResponse = new Promise((resolve) => {
    releaseDesktopFlow = resolve
  })
  const { switchWorkspace } = await import('../../src/renderer/src/lib/switch-workspace')
  const pending = switchWorkspace('team-a')
  await vi.waitFor(() => expect(state.invocations).toContain('desktop-flow:activity'))
  state.availableWorkspaceIds = ['local-personal', 'team-b']
  releaseDesktopFlow?.({ busy: false })
  await expect(pending).resolves.toBe(false)
  expect(state.activeWorkspaceId).toBe('local-personal')
  expect(state.releases).toBe(1)

  state.desktopFlowResponse = null
  await expect(switchWorkspace('team-b')).resolves.toBe(true)
  expect(state.activeWorkspaceId).toBe('team-b')
  expect(state.releases).toBe(2)
})

it('does not commit a revoked workspace after a delayed runtime switch acknowledgement', async () => {
  let releaseRuntime: ((value: unknown) => void) | undefined
  state.runtimeAvailable = true
  state.runtimeSwitchResponse = new Promise((resolve) => {
    releaseRuntime = resolve
  })
  const { switchWorkspace } = await import('../../src/renderer/src/lib/switch-workspace')
  const pending = switchWorkspace('team-a')
  await vi.waitFor(() => expect(state.runtimeSwitchCalls).toBe(1))
  state.availableWorkspaceIds = ['local-personal', 'team-b']
  releaseRuntime?.(undefined)
  await expect(pending).resolves.toBe(false)
  expect(state.activeWorkspaceId).toBe('local-personal')
  expect(state.releases).toBe(1)
})
