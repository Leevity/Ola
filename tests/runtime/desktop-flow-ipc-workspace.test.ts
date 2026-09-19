import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const sender = { id: 11, mainFrame: {}, once: vi.fn() }
  const window = { isDestroyed: () => false, webContents: sender }
  return {
    sender,
    window,
    handlers: new Map<string, (event: unknown, args: unknown) => Promise<unknown>>(),
    registeredWorkspaceId: 'team-a',
    recordingOwnerId: null as number | null,
    available: new Set(['team-a']),
    revokeDuringList: false,
    revokeDuringRunsList: false,
    revokeDuringNativeSave: false,
    runsListError: false,
    revokeDuringScreenshot: false,
    clicks: 0,
    replayApproved: false,
    saveError: null as Error | null,
    listedScopes: [] as string[],
    savedScopes: [] as string[],
    persistedFlows: [] as unknown[],
    startedRuns: [] as Array<{ flowId: string; workspaceId: string }>,
    finishedRuns: [] as Array<{ workspaceId: string; state: string }>,
    localStartedRuns: [] as Array<{ flowId: string; workspaceId: string }>,
    localFinishedRuns: [] as Array<{ workspaceId: string; state: string }>,
    localRuns: [] as Array<{ id: string; flowId: string; state: string; startedAt: number }>,
    localFlows: [] as Array<{
      id: string
      workspaceId: string
      name: string
      updatedAt: number
      steps: unknown[]
    }>,
    deletedFlowIds: [] as string[],
    auditStartError: false,
    auditFinishError: false,
    holdNativeDelete: false,
    nativeDeleteEntered: false,
    releaseNativeDelete: null as (() => void) | null,
    holdNativeSave: false,
    nativeSaveEntered: false,
    releaseNativeSave: null as (() => void) | null,
    localSaves: 0
  }
})

const teamFlow = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: 'team-a',
  name: 'Team flow',
  createdAt: 1,
  updatedAt: 1,
  steps: []
}

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (value: unknown) => (value === state.sender ? state.window : null)
  },
  dialog: { showMessageBox: async () => ({ response: state.replayApproved ? 1 : 0 }) },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => Promise<unknown>) => {
      state.handlers.set(channel, handler)
    }
  }
}))
vi.mock('../../src/main/window-ipc', () => ({
  getRegisteredWindowWorkspace: () => state.registeredWorkspaceId
}))
vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: async () => state.available
}))
vi.mock('../../src/main/desktop/desktop-flow-recorder', () => ({
  getActiveDesktopFlow: () => null,
  getDesktopFlowRecordingOwnerId: () => state.recordingOwnerId,
  getDesktopFlowRecordingStatus: () => ({ recording: false }),
  setDesktopFlowRecordingPaused: () => ({ recording: false }),
  startDesktopFlowRecording: () => teamFlow,
  stopDesktopFlowRecording: () => null,
  updateActiveDesktopFlow: () => null
}))
vi.mock('../../src/main/ipc/desktop-control', () => ({
  captureDesktopScreenshot: async () => {
    if (state.revokeDuringScreenshot) state.available = new Set()
    return { success: true, data: Buffer.from('frame').toString('base64') }
  },
  desktopInputClick: () => {
    state.clicks++
    return { success: true }
  },
  desktopInputScroll: () => ({ success: true }),
  desktopInputType: () => ({ success: true })
}))
vi.mock('../../src/main/desktop/desktop-flow-store', () => ({
  deleteDesktopFlow: (id: string) => {
    state.deletedFlowIds.push(id)
    return true
  },
  finishDesktopFlowRun: (_id: string, workspaceId: string, runState: string) => {
    state.localFinishedRuns.push({ workspaceId, state: runState })
    return true
  },
  listDesktopFlowDeletions: () => state.deletedFlowIds,
  listDesktopFlows: () => state.localFlows,
  listDesktopFlowRuns: () => state.localRuns,
  redactDesktopFlowCapturedText: (flow: {
    steps: Array<{ type: string; text?: string; expectedChange?: string }>
    requiresReview?: boolean
  }) => {
    const copy = structuredClone(flow)
    for (const step of copy.steps) {
      if (step.type === 'type' && step.text) {
        delete step.text
        step.expectedChange = 'Captured input removed for safety. Recreate this step.'
        copy.requiresReview = true
      }
    }
    return copy
  },
  saveDesktopFlow: (flow: unknown) => {
    state.localSaves++
    return flow
  },
  startDesktopFlowRun: (_id: string, flowId: string, workspaceId: string) => {
    state.localStartedRuns.push({ flowId, workspaceId })
  }
}))
vi.mock('../../src/main/db/capability-dao', () => ({
  deletePersistedDesktopFlow: async () => {
    state.nativeDeleteEntered = true
    if (state.holdNativeDelete)
      await new Promise<void>((resolve) => {
        state.releaseNativeDelete = resolve
      })
    return false
  },
  finishPersistedDesktopFlowRun: async (_id: string, workspaceId: string, runState: string) => {
    if (state.auditFinishError) throw new Error('Native finish unavailable')
    state.finishedRuns.push({ workspaceId, state: runState })
    return true
  },
  listPersistedDesktopFlowRuns: async () => {
    if (state.revokeDuringRunsList) state.available = new Set()
    if (state.runsListError) throw new Error('Native unavailable')
    return [{ id: 'run-a', flowId: teamFlow.id, state: 'succeeded', startedAt: 1 }]
  },
  listPersistedDesktopFlows: async (workspaceId: string) => {
    state.listedScopes.push(workspaceId)
    if (state.revokeDuringList) state.available = new Set()
    return [teamFlow]
  },
  persistDesktopFlow: async (_flow: unknown, workspaceId: string) => {
    state.nativeSaveEntered = true
    if (state.holdNativeSave)
      await new Promise<void>((resolve) => {
        state.releaseNativeSave = resolve
      })
    state.savedScopes.push(workspaceId)
    state.persistedFlows.push(_flow)
    if (state.revokeDuringNativeSave) state.available = new Set()
    if (state.saveError) throw state.saveError
  },
  startPersistedDesktopFlowRun: async (_id: string, flowId: string, workspaceId: string) => {
    if (state.auditStartError) throw new Error('Native unavailable')
    state.startedRuns.push({ flowId, workspaceId })
  }
}))

import {
  beginDesktopFlowWorkspaceSwitch,
  isDesktopFlowActiveForSender,
  registerDesktopFlowHandlers
} from '../../src/main/ipc/desktop-flow-handlers'

const event = { sender: state.sender, senderFrame: state.sender.mainFrame }

beforeEach(() => {
  state.handlers.clear()
  state.registeredWorkspaceId = 'team-a'
  state.recordingOwnerId = null
  state.available = new Set(['team-a'])
  state.revokeDuringList = false
  state.revokeDuringRunsList = false
  state.revokeDuringNativeSave = false
  state.runsListError = false
  state.revokeDuringScreenshot = false
  state.clicks = 0
  state.replayApproved = false
  state.saveError = null
  state.listedScopes = []
  state.savedScopes = []
  state.persistedFlows = []
  state.startedRuns = []
  state.finishedRuns = []
  state.localStartedRuns = []
  state.localFinishedRuns = []
  state.localRuns = []
  state.localFlows = []
  state.deletedFlowIds = []
  state.auditStartError = false
  state.auditFinishError = false
  state.holdNativeDelete = false
  state.nativeDeleteEntered = false
  state.releaseNativeDelete = null
  state.holdNativeSave = false
  state.nativeSaveEntered = false
  state.releaseNativeSave = null
  state.localSaves = 0
  registerDesktopFlowHandlers()
})

it('lists and saves only flows owned by the sender window workspace', async () => {
  const list = state.handlers.get('desktop-flow:list')!
  await expect(list(event, { workspaceId: 'team-a' })).resolves.toEqual([teamFlow])
  expect(state.listedScopes).toEqual(['team-a'])
  await expect(list(event, { workspaceId: 'local-personal' })).rejects.toThrow(
    'DESKTOP_FLOW_WORKSPACE_UNAVAILABLE'
  )
  const save = state.handlers.get('desktop-flow:save')!
  await expect(save(event, teamFlow)).resolves.toEqual(teamFlow)
  expect(state.savedScopes).toEqual(['team-a'])
  await expect(save(event, { ...teamFlow, workspaceId: 'local-personal' })).rejects.toThrow(
    'DESKTOP_FLOW_WORKSPACE_UNAVAILABLE'
  )
})

it('merges offline-created flows and hides tombstoned Native flows', async () => {
  state.localFlows = [
    {
      id: '22222222-2222-4222-8222-222222222222',
      workspaceId: 'team-a',
      name: 'Offline',
      updatedAt: 2,
      steps: []
    }
  ]
  const list = state.handlers.get('desktop-flow:list')!
  const merged = (await list(event, { workspaceId: 'team-a' })) as Array<{ name: string }>
  expect(merged.map((flow) => flow.name)).toEqual(['Offline', 'Team flow'])
  state.deletedFlowIds = [teamFlow.id]
  const afterDelete = (await list(event, { workspaceId: 'team-a' })) as Array<{ name: string }>
  expect(afterDelete.map((flow) => flow.name)).toEqual(['Offline'])
})

it('reconciles a local-only flow through the authorized Main IPC boundary', async () => {
  state.localFlows = [
    {
      id: '22222222-2222-4222-8222-222222222222',
      workspaceId: 'team-a',
      name: 'Offline',
      updatedAt: 2,
      steps: []
    }
  ]
  const sync = state.handlers.get('desktop-flow:sync')!
  await expect(sync(event, { workspaceId: 'team-a' })).resolves.toMatchObject({
    available: true,
    savedFlows: 1,
    failed: 0
  })
  expect(state.savedScopes).toEqual(['team-a'])
  await expect(sync(event, { workspaceId: 'team-b' })).rejects.toThrow(
    'DESKTOP_FLOW_WORKSPACE_UNAVAILABLE'
  )
})

it('does not return a successful reconciliation after team authorization is revoked mid-write', async () => {
  state.localFlows = [
    {
      id: '22222222-2222-4222-8222-222222222222',
      workspaceId: 'team-a',
      name: 'Offline',
      updatedAt: 2,
      steps: []
    }
  ]
  state.revokeDuringNativeSave = true
  const sync = state.handlers.get('desktop-flow:sync')!
  await expect(sync(event, { workspaceId: 'team-a' })).rejects.toThrow(
    'CHANNEL_WORKSPACE_UNAVAILABLE'
  )
})

it('keeps a locally deleted flow hidden if a stale Native list later returns it', async () => {
  const remove = state.handlers.get('desktop-flow:delete')!
  await expect(remove(event, { workspaceId: 'team-a', id: teamFlow.id })).resolves.toEqual({
    success: true
  })
  const list = state.handlers.get('desktop-flow:list')!
  await expect(list(event, { workspaceId: 'team-a' })).resolves.toEqual([])
})

it('does not return team flows after authorization is revoked during listing', async () => {
  state.revokeDuringList = true
  const list = state.handlers.get('desktop-flow:list')!
  await expect(list(event, { workspaceId: 'team-a' })).rejects.toThrow(
    'CHANNEL_WORKSPACE_UNAVAILABLE'
  )
})

it('does not return team run history after authorization is revoked during listing', async () => {
  state.revokeDuringRunsList = true
  const list = state.handlers.get('desktop-flow:runs-list')!
  await expect(list(event, { workspaceId: 'team-a' })).rejects.toThrow(
    'CHANNEL_WORKSPACE_UNAVAILABLE'
  )
})

it('keeps flow listing available when only run history persistence is unavailable', async () => {
  state.runsListError = true
  state.localRuns = [{ id: 'local-run', flowId: teamFlow.id, state: 'cancelled', startedAt: 2 }]
  const listRuns = state.handlers.get('desktop-flow:runs-list')!
  await expect(listRuns(event, { workspaceId: 'team-a' })).resolves.toEqual(state.localRuns)
  const listFlows = state.handlers.get('desktop-flow:list')!
  await expect(listFlows(event, { workspaceId: 'team-a' })).resolves.toEqual([teamFlow])
})

it('merges Native and offline run history for the authorized workspace', async () => {
  state.localRuns = [{ id: 'local-run', flowId: teamFlow.id, state: 'cancelled', startedAt: 2 }]
  const listRuns = state.handlers.get('desktop-flow:runs-list')!
  const rows = (await listRuns(event, { workspaceId: 'team-a' })) as Array<{ id: string }>
  expect(rows.map((row) => row.id)).toEqual(['local-run', 'run-a'])
})

it('does not create a local fallback when Native detects a cross-workspace ID collision', async () => {
  state.saveError = new Error('Desktop flow belongs to another workspace.')
  const save = state.handlers.get('desktop-flow:save')!
  await expect(save(event, teamFlow)).rejects.toThrow('belongs to another workspace')
  expect(state.localSaves).toBe(0)
})

it('marks only the recording owner as busy for a main-process workspace switch', () => {
  state.recordingOwnerId = state.sender.id
  expect(isDesktopFlowActiveForSender(state.sender.id)).toBe(true)
  expect(isDesktopFlowActiveForSender(state.sender.id + 1)).toBe(false)
})

it('blocks recording and replay admission during a workspace switch', async () => {
  const release = beginDesktopFlowWorkspaceSwitch()
  expect(() => beginDesktopFlowWorkspaceSwitch()).toThrow('WORKSPACE_BUSY_DESKTOP_FLOW')
  const start = state.handlers.get('desktop-recorder:start')!
  await expect(start(event, { workspaceId: 'team-a' })).rejects.toThrow(
    'WORKSPACE_BUSY_DESKTOP_FLOW'
  )
  const replay = state.handlers.get('desktop-flow:replay')!
  await expect(replay(event, { workspaceId: 'team-a', flow: teamFlow })).resolves.toMatchObject({
    success: false,
    error: 'WORKSPACE_BUSY_DESKTOP_FLOW'
  })
  release()
  release()
  await expect(start(event, { workspaceId: 'team-a' })).resolves.toMatchObject({
    workspaceId: 'team-a'
  })
})

it('redacts captured input before persisting a desktop flow in Native', async () => {
  const save = state.handlers.get('desktop-flow:save')!
  await save(event, {
    ...teamFlow,
    steps: [
      { id: 'typed-step', type: 'type', text: 'private input', createdAt: 1, riskLevel: 'high' }
    ]
  })
  expect(state.persistedFlows).toMatchObject([
    { requiresReview: true, steps: [{ id: 'typed-step', expectedChange: expect.any(String) }] }
  ])
  expect(JSON.stringify(state.persistedFlows)).not.toContain('private input')
})

it('does not issue desktop input after team authorization is revoked during screenshot capture', async () => {
  state.revokeDuringScreenshot = true
  state.replayApproved = true
  const replay = state.handlers.get('desktop-flow:replay')!
  await expect(
    replay(event, {
      workspaceId: 'team-a',
      flow: {
        ...teamFlow,
        steps: [{ id: 'click-a', type: 'click', x: 5, y: 5, createdAt: 1, riskLevel: 'low' }]
      }
    })
  ).rejects.toThrow('CHANNEL_WORKSPACE_UNAVAILABLE')
  expect(state.clicks).toBe(0)
  expect(state.finishedRuns).toEqual([{ workspaceId: 'team-a', state: 'failed' }])
})

it('requires approval for desktop input even when flow risk metadata says low', async () => {
  const replay = state.handlers.get('desktop-flow:replay')!
  const args = {
    workspaceId: 'team-a',
    verifyScreenshots: false,
    flow: {
      ...teamFlow,
      steps: [{ id: 'click-a', type: 'click', x: 5, y: 5, createdAt: 1, riskLevel: 'low' }]
    }
  }
  await expect(replay(event, args)).resolves.toMatchObject({ success: false })
  expect(state.clicks).toBe(0)
  state.replayApproved = true
  await expect(replay(event, args)).resolves.toMatchObject({ success: true })
  expect(state.clicks).toBe(1)
  expect(state.startedRuns).toEqual([{ flowId: teamFlow.id, workspaceId: 'team-a' }])
  expect(state.finishedRuns).toEqual([{ workspaceId: 'team-a', state: 'succeeded' }])
})

it('records cancellation rather than success when the final wait step is cancelled', async () => {
  const replay = state.handlers.get('desktop-flow:replay')!
  const pending = replay(event, {
    workspaceId: 'team-a',
    flow: {
      ...teamFlow,
      steps: [{ id: 'wait-a', type: 'wait', createdAt: 1, riskLevel: 'low' }]
    }
  })
  await vi.waitFor(() => expect(state.startedRuns).toHaveLength(1))
  const cancel = state.handlers.get('desktop-flow:cancel')!
  await expect(cancel(event, { workspaceId: 'team-a' })).resolves.toEqual({ success: true })
  const remove = state.handlers.get('desktop-flow:delete')!
  await expect(remove(event, { workspaceId: 'team-a', id: teamFlow.id })).rejects.toThrow(
    'DESKTOP_FLOW_REPLAY_ACTIVE'
  )
  await expect(
    replay(event, { workspaceId: 'team-a', flow: { ...teamFlow, steps: [] } })
  ).resolves.toMatchObject({ success: false, error: expect.stringContaining('already running') })
  await expect(pending).resolves.toMatchObject({
    success: false,
    error: expect.stringContaining('cancelled')
  })
  expect(state.finishedRuns).toEqual([{ workspaceId: 'team-a', state: 'cancelled' }])
})

it('rejects omitted typing steps before starting an audit run or desktop input', async () => {
  const replay = state.handlers.get('desktop-flow:replay')!
  await expect(
    replay(event, {
      workspaceId: 'team-a',
      flow: {
        ...teamFlow,
        steps: [{ id: 'typed', type: 'type', createdAt: 1, riskLevel: 'low' }]
      }
    })
  ).resolves.toMatchObject({
    success: false,
    error: expect.stringContaining('cannot be safely replayed')
  })
  expect(state.startedRuns).toEqual([])
  expect(state.clicks).toBe(0)
})

it('keeps local flow replay available when the Native run journal cannot start', async () => {
  state.auditStartError = true
  const replay = state.handlers.get('desktop-flow:replay')!
  await expect(
    replay(event, {
      workspaceId: 'team-a',
      flow: { ...teamFlow, steps: [] }
    })
  ).resolves.toMatchObject({ success: true })
  expect(state.startedRuns).toEqual([])
  expect(state.finishedRuns).toEqual([])
  expect(state.localStartedRuns).toEqual([{ flowId: teamFlow.id, workspaceId: 'team-a' }])
  expect(state.localFinishedRuns).toEqual([{ workspaceId: 'team-a', state: 'succeeded' }])
})

it('recovers a Native run finish failure into the offline journal', async () => {
  state.auditFinishError = true
  const replay = state.handlers.get('desktop-flow:replay')!
  await expect(replay(event, { workspaceId: 'team-a', flow: teamFlow })).resolves.toMatchObject({
    success: true
  })
  expect(state.startedRuns).toEqual([{ flowId: teamFlow.id, workspaceId: 'team-a' }])
  expect(state.localStartedRuns).toEqual([{ flowId: teamFlow.id, workspaceId: 'team-a' }])
  expect(state.localFinishedRuns).toEqual([{ workspaceId: 'team-a', state: 'succeeded' }])
})

it('does not begin replay while deletion of the same flow is pending', async () => {
  state.holdNativeDelete = true
  const remove = state.handlers.get('desktop-flow:delete')!
  const pendingDelete = remove(event, { workspaceId: 'team-a', id: teamFlow.id })
  await vi.waitFor(() => expect(state.nativeDeleteEntered).toBe(true))
  const replay = state.handlers.get('desktop-flow:replay')!
  await expect(replay(event, { workspaceId: 'team-a', flow: teamFlow })).resolves.toMatchObject({
    success: false,
    error: expect.stringContaining('deletion is still in progress')
  })
  state.releaseNativeDelete?.()
  await pendingDelete
})

it('serializes save against deletion and replay of the same flow', async () => {
  state.holdNativeSave = true
  const save = state.handlers.get('desktop-flow:save')!
  const pendingSave = save(event, teamFlow)
  await vi.waitFor(() => expect(state.nativeSaveEntered).toBe(true))
  const remove = state.handlers.get('desktop-flow:delete')!
  await expect(remove(event, { workspaceId: 'team-a', id: teamFlow.id })).rejects.toThrow(
    'DESKTOP_FLOW_MUTATION_ACTIVE'
  )
  const replay = state.handlers.get('desktop-flow:replay')!
  await expect(replay(event, { workspaceId: 'team-a', flow: teamFlow })).resolves.toMatchObject({
    success: false,
    error: expect.stringContaining('save is still in progress')
  })
  state.releaseNativeSave?.()
  await expect(pendingSave).resolves.toEqual(teamFlow)
})
