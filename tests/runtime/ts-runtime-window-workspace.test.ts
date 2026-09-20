import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (args: unknown, event: unknown) => Promise<unknown>>(),
  registeredWorkspace: 'team-a',
  runtimeAvailable: true,
  cronBusy: false,
  cronSwitchPending: false,
  desktopFlowBusy: false,
  desktopFlowSwitchPending: false,
  sshBusy: false,
  sshSwitchPending: false,
  getSession: vi.fn<(id: string, workspaceId: string) => Promise<unknown>>(),
  request: vi.fn<(method: string, params: unknown) => Promise<unknown>>()
}))
const webContents = { mainFrame: {} }
const window = { webContents, isDestroyed: () => false }
const event = { sender: webContents, senderFrame: webContents.mainFrame }

vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => window } }))
vi.mock('../../src/main/window-ipc', () => ({
  getRegisteredWindowWorkspace: () => state.registeredWorkspace
}))
vi.mock('../../src/main/runtime/desktop-runtime', () => ({
  desktopRuntime: {
    get isAvailable() {
      return state.runtimeAvailable
    },
    request: state.request
  }
}))
vi.mock('../../src/main/db/sessions-dao', () => ({ getSession: state.getSession }))
vi.mock('../../src/main/ipc/messagepack-handler', () => ({
  registerMessagePackHandler: (
    channel: string,
    handler: (args: unknown, event: unknown) => Promise<unknown>
  ) => {
    state.handlers.set(channel, handler)
  }
}))
vi.mock('../../src/main/ipc/ssh-handlers', () => ({
  hasActiveMainSshWorkspaceActivity: () => state.sshBusy,
  beginMainSshWorkspaceSwitch: () => {
    if (state.sshBusy || state.sshSwitchPending) throw new Error('WORKSPACE_BUSY_SSH')
    state.sshSwitchPending = true
    return () => {
      state.sshSwitchPending = false
    }
  }
}))
vi.mock('../../src/main/cron/cron-scheduler', () => ({
  hasActiveOrFinishingCronRuns: () => state.cronBusy,
  beginCronWorkspaceSwitch: () => {
    if (state.cronBusy || state.cronSwitchPending) throw new Error('WORKSPACE_BUSY_CRON')
    state.cronSwitchPending = true
    return () => {
      state.cronSwitchPending = false
    }
  }
}))
vi.mock('../../src/main/ipc/desktop-flow-handlers', () => ({
  beginDesktopFlowWorkspaceSwitch: () => {
    if (state.desktopFlowBusy || state.desktopFlowSwitchPending)
      throw new Error('WORKSPACE_BUSY_DESKTOP_FLOW')
    state.desktopFlowSwitchPending = true
    return () => {
      state.desktopFlowSwitchPending = false
    }
  }
}))

import { registerTsRuntimeHandlers } from '../../src/main/ipc/ts-runtime-handlers'

beforeEach(() => {
  state.handlers.clear()
  state.registeredWorkspace = 'team-a'
  state.runtimeAvailable = true
  state.cronBusy = false
  state.cronSwitchPending = false
  state.desktopFlowBusy = false
  state.desktopFlowSwitchPending = false
  state.sshBusy = false
  state.sshSwitchPending = false
  state.request.mockReset()
  state.getSession.mockReset()
  registerTsRuntimeHandlers()
})

function invoke(channel: string, args: unknown): Promise<unknown> {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`Missing handler: ${channel}`)
  return handler(args, event)
}

const teamRun = {
  runId: 'run-1',
  taskId: 'task-1',
  requestId: 'request-1',
  traceId: 'trace-1',
  sessionId: 'session-1',
  workspaceId: 'team-a',
  environmentId: 'local',
  modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
  prompt: 'hello',
  unattended: false
}

it('rejects another window workspace before reading or mutating TS runs', async () => {
  for (const [channel, args] of [
    ['ts-runtime:runs-list', { workspaceId: 'team-b' }],
    ['ts-runtime:run-snapshot', { workspaceId: 'team-b', runId: 'run-1', afterSeq: 0 }],
    ['ts-runtime:run-cancel', { workspaceId: 'team-b', runId: 'run-1' }],
    [
      'ts-runtime:run-interact',
      { workspaceId: 'team-b', runId: 'run-1', interactionId: 'approval', response: true }
    ]
  ] as const) {
    expect(await invoke(channel, args)).toMatchObject({ error: 'WINDOW_WORKSPACE_MISMATCH' })
  }
  expect(state.request).not.toHaveBeenCalled()
})

it('rejects a run submission for a workspace not owned by the calling window', async () => {
  const result = await invoke('ts-runtime:run-submit', {
    runId: 'run-1',
    taskId: 'task-1',
    requestId: 'request-1',
    traceId: 'trace-1',
    sessionId: 'session-1',
    workspaceId: 'team-b',
    environmentId: 'local',
    modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
    prompt: 'hello',
    unattended: false
  })
  expect(result).toMatchObject({ accepted: false, error: 'WINDOW_WORKSPACE_MISMATCH' })
  expect(state.request).not.toHaveBeenCalled()
  expect(state.getSession).not.toHaveBeenCalled()
})

it('requires the persisted business session to belong to the requested workspace', async () => {
  state.getSession.mockResolvedValue(undefined)
  const run = {
    runId: 'run-1',
    taskId: 'task-1',
    requestId: 'request-1',
    traceId: 'trace-1',
    sessionId: 'session-1',
    workspaceId: 'team-a',
    environmentId: 'local',
    modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
    prompt: 'hello',
    unattended: false
  }
  expect(await invoke('ts-runtime:run-submit', run)).toMatchObject({
    accepted: false,
    error: 'SESSION_WORKSPACE_MISMATCH'
  })
  expect(state.getSession).toHaveBeenCalledWith('session-1', 'team-a')
  expect(state.request).not.toHaveBeenCalled()

  state.getSession.mockResolvedValue({ id: 'session-1', workspace_id: 'team-a' })
  state.request.mockResolvedValue({ runId: 'run-1' })
  expect(await invoke('ts-runtime:run-submit', run)).toMatchObject({ accepted: true })
  expect(state.request).toHaveBeenCalledWith('run.submit', expect.objectContaining(run))
})

it('requires the registered source workspace before switching the runtime', async () => {
  expect(
    await invoke('ts-runtime:workspace-switch', {
      fromWorkspaceId: 'team-b',
      workspaceId: 'local-personal'
    })
  ).toMatchObject({ switched: false, error: 'WINDOW_WORKSPACE_MISMATCH' })
  expect(state.request).not.toHaveBeenCalled()

  state.request.mockResolvedValue({ ok: true })
  expect(
    await invoke('ts-runtime:workspace-switch', {
      fromWorkspaceId: 'team-a',
      workspaceId: 'local-personal'
    })
  ).toMatchObject({ switched: true })
  expect(state.request).toHaveBeenCalledWith('workspace.switch', {
    workspaceId: 'local-personal'
  })
  expect(state.cronSwitchPending).toBe(false)
  expect(state.desktopFlowSwitchPending).toBe(false)
  expect(state.sshSwitchPending).toBe(false)
})

it('does not switch while a TS run is waiting for session ownership or submission', async () => {
  let releaseSession: ((value: unknown) => void) | undefined
  state.getSession.mockImplementation(
    () =>
      new Promise((resolve) => {
        releaseSession = resolve
      })
  )
  state.request.mockResolvedValue({ runId: 'run-1' })
  const pending = invoke('ts-runtime:run-submit', teamRun)
  await vi.waitFor(() => expect(state.getSession).toHaveBeenCalledOnce())
  expect(await invoke('ts-runtime:workspace-activity', { workspaceId: 'team-a' })).toEqual({
    busy: true,
    reason: 'WORKSPACE_BUSY_TS_RUNTIME'
  })
  expect(
    await invoke('ts-runtime:workspace-switch', {
      fromWorkspaceId: 'team-a',
      workspaceId: 'local-personal'
    })
  ).toMatchObject({ switched: false, error: 'WORKSPACE_BUSY_TS_RUNTIME' })
  releaseSession?.({ id: 'session-1', workspace_id: 'team-a' })
  await expect(pending).resolves.toMatchObject({ accepted: true })
  expect(
    await invoke('ts-runtime:workspace-switch', {
      fromWorkspaceId: 'team-a',
      workspaceId: 'local-personal'
    })
  ).toMatchObject({ switched: true })
})

it('keeps the switch gate closed until the runtime confirms a run submission', async () => {
  state.getSession.mockResolvedValue({ id: 'session-1', workspace_id: 'team-a' })
  let releaseSubmission: ((value: unknown) => void) | undefined
  state.request.mockImplementation(
    () =>
      new Promise((resolve) => {
        releaseSubmission = resolve
      })
  )
  const pending = invoke('ts-runtime:run-submit', teamRun)
  await vi.waitFor(() => expect(state.request).toHaveBeenCalledWith('run.submit', teamRun))
  expect(
    await invoke('ts-runtime:workspace-switch', {
      fromWorkspaceId: 'team-a',
      workspaceId: 'local-personal'
    })
  ).toMatchObject({ switched: false, error: 'WORKSPACE_BUSY_TS_RUNTIME' })
  releaseSubmission?.({ runId: 'run-1' })
  await expect(pending).resolves.toMatchObject({ accepted: true })
})

it('does not return a stale submission after the window changes workspace', async () => {
  state.getSession.mockResolvedValue({ id: 'session-1', workspace_id: 'team-a' })
  let releaseSubmission: ((value: unknown) => void) | undefined
  state.request.mockImplementation((method) =>
    method === 'run.submit'
      ? new Promise((resolve) => {
          releaseSubmission = resolve
        })
      : Promise.resolve({ ok: true })
  )
  const pending = invoke('ts-runtime:run-submit', teamRun)
  await vi.waitFor(() => expect(state.request).toHaveBeenCalledWith('run.submit', teamRun))
  state.registeredWorkspace = 'team-b'
  releaseSubmission?.({ runId: 'run-1' })
  await expect(pending).resolves.toMatchObject({
    accepted: false,
    error: 'WINDOW_WORKSPACE_MISMATCH'
  })
  expect(state.request).toHaveBeenCalledWith('run.cancel', {
    workspaceId: 'team-a',
    runId: 'run-1'
  })
})

it('does not admit a TS run while a workspace switch is in flight', async () => {
  let releaseSwitch: ((value: unknown) => void) | undefined
  state.request.mockImplementation(
    () =>
      new Promise((resolve) => {
        releaseSwitch = resolve
      })
  )
  const pending = invoke('ts-runtime:workspace-switch', {
    fromWorkspaceId: 'team-a',
    workspaceId: 'local-personal'
  })
  await vi.waitFor(() => expect(state.request).toHaveBeenCalledOnce())
  expect(await invoke('ts-runtime:run-submit', teamRun)).toMatchObject({
    accepted: false,
    error: 'WORKSPACE_BUSY_TS_RUNTIME'
  })
  expect(state.getSession).not.toHaveBeenCalled()
  releaseSwitch?.({ ok: true })
  await expect(pending).resolves.toMatchObject({ switched: true })
})

it('rejects a delayed switch acknowledgement after the window changes workspace', async () => {
  let release: ((value: unknown) => void) | undefined
  state.request.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const pending = invoke('ts-runtime:workspace-switch', {
    fromWorkspaceId: 'team-a',
    workspaceId: 'local-personal'
  })
  await vi.waitFor(() => expect(state.request).toHaveBeenCalledOnce())
  expect(state.cronSwitchPending).toBe(true)
  expect(state.desktopFlowSwitchPending).toBe(true)
  expect(state.sshSwitchPending).toBe(true)
  await expect(
    invoke('ts-runtime:workspace-switch', {
      fromWorkspaceId: 'team-a',
      workspaceId: 'local-personal'
    })
  ).resolves.toMatchObject({ switched: false, error: 'WORKSPACE_BUSY_TS_RUNTIME' })
  state.registeredWorkspace = 'team-b'
  release?.({ ok: true })
  await expect(pending).resolves.toMatchObject({
    switched: false,
    error: 'WINDOW_WORKSPACE_MISMATCH'
  })
  expect(state.cronSwitchPending).toBe(false)
  expect(state.desktopFlowSwitchPending).toBe(false)
  expect(state.sshSwitchPending).toBe(false)
})

it('releases earlier admission guards when a desktop flow blocks switching', async () => {
  state.desktopFlowBusy = true
  await expect(
    invoke('ts-runtime:workspace-switch', {
      fromWorkspaceId: 'team-a',
      workspaceId: 'local-personal'
    })
  ).resolves.toMatchObject({ switched: false, error: 'WORKSPACE_BUSY_DESKTOP_FLOW' })
  expect(state.cronSwitchPending).toBe(false)
  expect(state.desktopFlowSwitchPending).toBe(false)
  expect(state.request).not.toHaveBeenCalled()
})

it('releases earlier admission guards when SSH blocks switching', async () => {
  state.sshBusy = true
  await expect(
    invoke('ts-runtime:workspace-switch', {
      fromWorkspaceId: 'team-a',
      workspaceId: 'local-personal'
    })
  ).resolves.toMatchObject({ switched: false, error: 'WORKSPACE_BUSY_SSH' })
  expect(state.cronSwitchPending).toBe(false)
  expect(state.desktopFlowSwitchPending).toBe(false)
  expect(state.sshSwitchPending).toBe(false)
  expect(state.request).not.toHaveBeenCalled()
})

it('reports Main-owned activity even when the TS runtime is unavailable', async () => {
  state.runtimeAvailable = false
  expect(await invoke('ts-runtime:workspace-activity', { workspaceId: 'team-b' })).toMatchObject({
    busy: true,
    error: 'WINDOW_WORKSPACE_MISMATCH'
  })
  state.cronBusy = true
  expect(await invoke('ts-runtime:workspace-activity', { workspaceId: 'team-a' })).toEqual({
    busy: true,
    reason: 'WORKSPACE_BUSY_CRON'
  })
  expect(
    await invoke('ts-runtime:workspace-switch', {
      fromWorkspaceId: 'team-a',
      workspaceId: 'local-personal'
    })
  ).toMatchObject({ switched: false, error: 'WORKSPACE_BUSY_CRON' })
  expect(state.cronSwitchPending).toBe(false)
  state.cronBusy = false
  state.sshBusy = true
  expect(await invoke('ts-runtime:workspace-activity', { workspaceId: 'team-a' })).toEqual({
    busy: true,
    reason: 'WORKSPACE_BUSY_SSH'
  })
  state.sshBusy = false
  expect(await invoke('ts-runtime:workspace-activity', { workspaceId: 'team-a' })).toEqual({
    busy: false
  })
})

it('discards a delayed list response after the window switches workspace', async () => {
  let release: ((value: unknown) => void) | undefined
  state.request.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const pending = invoke('ts-runtime:runs-list', { workspaceId: 'team-a' })
  await vi.waitFor(() => expect(state.request).toHaveBeenCalledOnce())
  state.registeredWorkspace = 'team-b'
  release?.([{ id: 'run-a' }])
  await expect(pending).resolves.toMatchObject({ runs: [], error: 'WINDOW_WORKSPACE_MISMATCH' })
})

it('reports TS-owned runtime routes and process memory without a Worker', async () => {
  expect(await invoke('worker:routes', undefined)).toMatchObject({
    runtime: 'typescript',
    routes: expect.arrayContaining(['run.submit', 'run.cancel']),
    capabilities: expect.arrayContaining(['runs', 'cancel'])
  })
  expect(await invoke('worker:memory', undefined)).toMatchObject({
    runtime: 'typescript',
    memory: expect.objectContaining({ rss: expect.any(Number) })
  })
})

it('routes legacy agent stop and reverse cancellation through the TS scheduler', async () => {
  state.request.mockResolvedValue({ ok: true })
  await expect(
    invoke('agent:request-stop', { workspaceId: 'team-a', runId: 'run-a' })
  ).resolves.toMatchObject({ cancelled: true, runId: 'run-a' })
  await expect(
    invoke('agent:reverse-cancel', { workspaceId: 'team-a', runId: 'run-b' })
  ).resolves.toMatchObject({ cancelled: true, runId: 'run-b' })
  expect(state.request).toHaveBeenNthCalledWith(1, 'run.cancel', {
    workspaceId: 'team-a',
    runId: 'run-a'
  })
  expect(state.request).toHaveBeenNthCalledWith(2, 'run.cancel', {
    workspaceId: 'team-a',
    runId: 'run-b'
  })
})

it('routes legacy reverse responses through the TS interaction scheduler', async () => {
  state.request.mockResolvedValue({ ok: true })
  await expect(
    invoke('agent:reverse-response', {
      workspaceId: 'team-a',
      runId: 'run-a',
      interactionId: 'interaction-a',
      response: { approved: true }
    })
  ).resolves.toEqual({ accepted: true })
  expect(state.request).toHaveBeenCalledWith('run.interact', {
    workspaceId: 'team-a',
    runId: 'run-a',
    interactionId: 'interaction-a',
    response: { approved: true }
  })
})
