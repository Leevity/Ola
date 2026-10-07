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
  statSshRuntimePath:
    vi.fn<(workspaceId: string, connectionId: string, path: string) => Promise<unknown>>(),
  getSession: vi.fn<(id: string, workspaceId: string) => Promise<unknown>>(),
  getTask: vi.fn<(id: string, workspaceId: string) => Promise<unknown>>(),
  getProject: vi.fn<(id: string, workspaceId: string) => Promise<unknown>>(),
  listCronRuns: vi.fn<(args: unknown) => Promise<unknown[]>>(),
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
vi.mock('../../src/main/db/tasks-dao', () => ({ getTask: state.getTask }))
vi.mock('../../src/main/db/projects-dao', () => ({ getProject: state.getProject }))
vi.mock('../../src/main/db/cron-dao', () => ({ listCronRuns: state.listCronRuns }))
vi.mock('../../src/main/ipc/messagepack-handler', () => ({
  registerMessagePackHandler: (
    channel: string,
    handler: (args: unknown, event: unknown) => Promise<unknown>
  ) => {
    state.handlers.set(channel, handler)
  }
}))
vi.mock('../../src/main/ipc/ssh-handlers', () => ({
  statSshRuntimePath: state.statSshRuntimePath,
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
  state.statSshRuntimePath.mockReset()
  state.request.mockReset()
  state.getSession.mockReset()
  state.getTask.mockReset()
  state.getProject.mockReset()
  state.listCronRuns.mockReset()
  state.listCronRuns.mockResolvedValue([])
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

function keyPage<T>(
  items: T[],
  params: unknown,
  key: (item: T) => { at: number; id: string }
): T[] {
  const request = params as {
    limit: number
    anchor?: { at: number; id: string }
    after?: { at: number; id: string }
  }
  const within = (item: T, boundary: { at: number; id: string }, inclusive: boolean): boolean => {
    const current = key(item)
    return (
      current.at < boundary.at ||
      (current.at === boundary.at &&
        (inclusive ? current.id <= boundary.id : current.id < boundary.id))
    )
  }
  return items
    .filter(
      (item) =>
        (!request.anchor || within(item, request.anchor, true)) &&
        (!request.after || within(item, request.after, false))
    )
    .slice(0, request.limit)
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

it('keeps the unified run list inside the authorized window workspace', async () => {
  expect(await invoke('execution-records:list', { workspaceId: 'team-b' })).toMatchObject({
    records: [],
    error: 'WINDOW_WORKSPACE_MISMATCH'
  })
  expect(state.request).not.toHaveBeenCalled()
  expect(state.listCronRuns).not.toHaveBeenCalled()

  state.getSession.mockResolvedValue({
    id: 'session-1',
    title: 'Review project',
    project_id: 'project-1'
  })
  state.request.mockImplementation(async (method) =>
    method === 'run.list'
      ? [
          { ...teamRun, status: 'completed', createdAt: 10, updatedAt: 20 },
          { ...teamRun, runId: 'foreign', workspaceId: 'team-b' }
        ]
      : { events: [], pendingInteractions: [] }
  )
  const result = await invoke('execution-records:list', { workspaceId: 'team-a' })
  expect(result).toMatchObject({
    records: [
      {
        id: 'run-1',
        workspaceId: 'team-a',
        title: 'Review project',
        projectId: 'project-1',
        status: 'completed'
      }
    ]
  })
  expect(state.getSession).toHaveBeenCalledTimes(1)
  expect(state.listCronRuns).toHaveBeenCalledWith({
    workspaceId: 'team-a',
    limit: 51,
    attentionOnly: false
  })
})

it('pages merged TS and Cron history without repeating either source', async () => {
  const tsRuns = Array.from({ length: 56 }, (_, index) => ({
    ...teamRun,
    runId: `ts-${index}`,
    status: 'completed',
    createdAt: 200 - index * 2,
    updatedAt: 201 - index * 2
  }))
  const cronRuns = Array.from({ length: 10 }, (_, index) => ({
    id: `cron-${index}`,
    job_id: 'job-1',
    started_at: 199 - index * 2,
    status: 'success'
  }))
  state.getSession.mockResolvedValue(undefined)
  state.request.mockImplementation(async (method, params) => {
    if (method === 'run.list') {
      return keyPage(tsRuns, params, (run) => ({ at: run.createdAt, id: run.runId }))
    }
    return { events: [], pendingInteractions: [] }
  })
  state.listCronRuns.mockImplementation(async (args) => {
    return keyPage(cronRuns, args, (run) => ({ at: run.started_at, id: run.id }))
  })
  const first = (await invoke('execution-records:list', {
    workspaceId: 'team-a'
  })) as { records: Array<{ id: string }>; nextCursor: unknown }
  expect(first.records).toHaveLength(50)
  expect(first.nextCursor).toEqual({
    ts: { anchor: { at: 200, id: 'ts-0' }, after: { at: 122, id: 'ts-39' } },
    cron: { anchor: { at: 199, id: 'cron-0' }, after: { at: 181, id: 'cron-9' } }
  })
  tsRuns.unshift({
    ...teamRun,
    runId: 'ts-new',
    status: 'completed',
    createdAt: 300,
    updatedAt: 301
  })
  tsRuns.splice(
    tsRuns.findIndex((run) => run.runId === 'ts-5'),
    1
  )
  const second = (await invoke('execution-records:list', {
    workspaceId: 'team-a',
    cursor: first.nextCursor
  })) as { records: Array<{ id: string }>; nextCursor: unknown }
  expect(second.records).toHaveLength(16)
  expect(second.nextCursor).toBeNull()
  expect(new Set([...first.records, ...second.records].map((record) => record.id)).size).toBe(66)
  expect(second.records.some((record) => record.id === 'ts-new')).toBe(false)
  expect(
    await invoke('execution-records:list', {
      workspaceId: 'team-a',
      cursor: {
        ts: { anchor: null, after: { at: 1, id: 'invalid' } },
        cron: { anchor: null, after: null }
      }
    })
  ).toMatchObject({ error: 'INVALID_REQUEST' })
})

it('passes the attention filter to both durable sources before paging', async () => {
  state.getSession.mockResolvedValue(undefined)
  state.request.mockImplementation(async (method) =>
    method === 'run.list'
      ? [{ ...teamRun, status: 'failed', createdAt: 10, updatedAt: 20 }]
      : { events: [], pendingInteractions: [] }
  )
  state.listCronRuns.mockResolvedValue([
    { id: 'cron-failed', job_id: 'job-1', started_at: 9, status: 'error' }
  ])
  const result = await invoke('execution-records:list', {
    workspaceId: 'team-a',
    filter: 'attention'
  })
  expect(result).toMatchObject({ records: [{ id: 'run-1' }, { id: 'cron-failed' }] })
  expect(state.request).toHaveBeenCalledWith('run.list', {
    workspaceId: 'team-a',
    limit: 51,
    attentionOnly: true
  })
  expect(state.listCronRuns).toHaveBeenCalledWith({
    workspaceId: 'team-a',
    limit: 51,
    attentionOnly: true
  })
  expect(
    await invoke('execution-records:list', {
      workspaceId: 'team-a',
      filter: 'unsupported'
    })
  ).toMatchObject({ error: 'INVALID_REQUEST' })
})

it('keeps source order when many runs share the same timestamp', async () => {
  const runs = Array.from({ length: 60 }, (_, index) => ({
    ...teamRun,
    runId: `run-${String(59 - index).padStart(3, '0')}`,
    status: 'completed',
    createdAt: 100,
    updatedAt: 101
  }))
  state.getSession.mockResolvedValue(undefined)
  state.request.mockImplementation(async (method, params) => {
    if (method === 'run.list') {
      return keyPage(runs, params, (run) => ({ at: run.createdAt, id: run.runId }))
    }
    return { events: [], pendingInteractions: [] }
  })
  const first = (await invoke('execution-records:list', { workspaceId: 'team-a' })) as {
    records: Array<{ id: string }>
    nextCursor: unknown
  }
  const second = (await invoke('execution-records:list', {
    workspaceId: 'team-a',
    cursor: first.nextCursor
  })) as { records: Array<{ id: string }> }
  expect([...first.records, ...second.records].map((record) => record.id)).toEqual(
    runs.map((run) => run.runId)
  )
})

it('lists only scoped, confirmed artifact events and reports missing files', async () => {
  expect(await invoke('execution-artifacts:list', { workspaceId: 'team-b' })).toMatchObject({
    artifacts: [],
    error: 'WINDOW_WORKSPACE_MISMATCH'
  })
  expect(state.request).not.toHaveBeenCalled()
  state.getSession.mockResolvedValue({ id: 'session-1', project_id: 'project-1' })
  state.getProject.mockResolvedValue({ id: 'project-1' })
  state.request.mockImplementation(async (method) =>
    method === 'artifact.list'
      ? [
          {
            runId: 'run-1',
            seq: 4,
            data: {
              toolCallId: 'write-1',
              kind: 'file',
              mediaType: 'image/png',
              path: 'C:\\ola-artifact-not-present.md',
              operation: 'create'
            },
            timestamp: 100,
            sessionId: 'session-1',
            status: 'completed',
            projectId: 'project-1'
          }
        ]
      : []
  )
  const result = await invoke('execution-artifacts:list', {
    workspaceId: 'team-a',
    projectId: 'project-1',
    runId: 'run-1'
  })
  expect(result).not.toHaveProperty('error')
  expect(result).toMatchObject({
    artifacts: [
      {
        id: 'run-1:4',
        projectId: 'project-1',
        runId: 'run-1',
        mediaType: 'image/png',
        exists: false
      }
    ],
    nextOffset: null
  })
  expect(state.getProject).toHaveBeenCalledWith('project-1', 'team-a')
  expect(state.request).toHaveBeenCalledWith(
    'artifact.list',
    expect.objectContaining({ workspaceId: 'team-a', runId: 'run-1' })
  )
  expect(
    await invoke('execution-artifacts:list', { workspaceId: 'team-a', runId: '' })
  ).toMatchObject({ artifacts: [], error: 'INVALID_ARTIFACT_QUERY' })
})

it('advances the artifact cursor by consumed rows when a page fills early', async () => {
  state.getSession.mockResolvedValue({ id: 'session-1', project_id: null })
  const entries = [1, 2].map((seq) => ({
    runId: 'run-1',
    seq,
    data: {
      toolCallId: `write-${seq}`,
      kind: 'file',
      path: `C:\\ola-artifact-${seq}-not-present.md`,
      operation: 'create'
    },
    timestamp: seq,
    sessionId: 'session-1',
    status: 'completed',
    projectId: null
  }))
  state.request.mockImplementation(async (method, params) => {
    if (method !== 'artifact.list') return []
    const offset = (params as { offset: number }).offset
    return entries.slice(offset, offset + 100)
  })
  const first = await invoke('execution-artifacts:list', {
    workspaceId: 'team-a',
    limit: 1
  })
  expect(first).toMatchObject({ artifacts: [{ id: 'run-1:1' }], nextOffset: 1 })
  const second = await invoke('execution-artifacts:list', {
    workspaceId: 'team-a',
    limit: 1,
    offset: 1
  })
  expect(second).toMatchObject({ artifacts: [{ id: 'run-1:2' }], nextOffset: null })
})

it('filters artifacts by inferred file category before paging', async () => {
  state.getSession.mockResolvedValue({ id: 'session-1', project_id: null })
  const entries = [
    'notes.md',
    'chart.png',
    'data.csv',
    'sound.wav',
    'clip.mp4',
    'photo.heic',
    'workbook.xlsx'
  ].map((name, index) => ({
    runId: 'run-category',
    seq: index + 1,
    data: {
      toolCallId: `write-${index + 1}`,
      kind: 'file',
      path: `C:\\ola-${name}`,
      operation: 'create'
    },
    timestamp: index + 1,
    sessionId: 'session-1',
    status: 'completed',
    projectId: null
  }))
  state.request.mockImplementation(async (method, params) => {
    if (method !== 'artifact.list') return []
    const offset = (params as { offset: number }).offset
    return entries.slice(offset, offset + 100)
  })
  const first = await invoke('execution-artifacts:list', {
    workspaceId: 'team-a',
    category: 'image',
    limit: 1
  })
  expect(first).toMatchObject({ artifacts: [{ title: 'ola-chart.png' }], nextOffset: 2 })
  const second = await invoke('execution-artifacts:list', {
    workspaceId: 'team-a',
    category: 'data',
    createdAfter: 3,
    offset: 0,
    limit: 1
  })
  expect(second).toMatchObject({ artifacts: [{ title: 'ola-data.csv' }], nextOffset: 3 })
  const recent = await invoke('execution-artifacts:list', {
    workspaceId: 'team-a',
    category: 'media',
    createdAfter: 5
  })
  expect(recent).toMatchObject({
    artifacts: [{ title: 'ola-clip.mp4', mediaType: 'video/mp4' }],
    nextOffset: null
  })
  const media = await invoke('execution-artifacts:list', {
    workspaceId: 'team-a',
    category: 'media'
  })
  expect(media).toMatchObject({
    artifacts: [
      { title: 'ola-sound.wav', mediaType: 'audio/wav' },
      { title: 'ola-clip.mp4', mediaType: 'video/mp4' }
    ],
    nextOffset: null
  })
  const images = await invoke('execution-artifacts:list', {
    workspaceId: 'team-a',
    category: 'image'
  })
  expect(images).toMatchObject({
    artifacts: [
      { title: 'ola-chart.png', mediaType: 'image/png' },
      { title: 'ola-photo.heic', mediaType: 'image/heic' }
    ],
    nextOffset: null
  })
  const dataFiles = await invoke('execution-artifacts:list', {
    workspaceId: 'team-a',
    category: 'data'
  })
  expect(dataFiles).toMatchObject({
    artifacts: [{ title: 'ola-data.csv' }, { title: 'ola-workbook.xlsx' }],
    nextOffset: null
  })
  expect(
    await invoke('execution-artifacts:list', { workspaceId: 'team-a', category: 'executable' })
  ).toMatchObject({ artifacts: [], error: 'INVALID_ARTIFACT_QUERY' })
  expect(
    await invoke('execution-artifacts:list', { workspaceId: 'team-a', createdAfter: -1 })
  ).toMatchObject({ artifacts: [], error: 'INVALID_ARTIFACT_QUERY' })
})

it('lists only validated HTTP(S) link artifacts with project and workspace scope', async () => {
  state.getSession.mockResolvedValue({ id: 'session-link', project_id: 'project-link' })
  state.getProject.mockResolvedValue({ id: 'project-link' })
  state.request.mockResolvedValue([
    {
      runId: 'run-link',
      seq: 1,
      data: {
        toolCallId: 'extension-1',
        kind: 'link',
        transport: 'remote',
        url: 'https://reports.example.com/quarterly',
        title: 'Quarterly report'
      },
      timestamp: 10,
      sessionId: 'session-link',
      status: 'completed',
      projectId: 'project-link'
    },
    {
      runId: 'run-link',
      seq: 2,
      data: {
        toolCallId: 'extension-2',
        kind: 'link',
        url: 'javascript:alert(1)',
        title: 'Unsafe link'
      },
      timestamp: 11,
      sessionId: 'session-link',
      status: 'completed',
      projectId: 'project-link'
    }
  ])
  const result = await invoke('execution-artifacts:list', {
    workspaceId: 'team-a',
    projectId: 'project-link',
    category: 'link'
  })
  expect(result).toMatchObject({
    artifacts: [
      {
        kind: 'link',
        title: 'Quarterly report',
        url: 'https://reports.example.com/quarterly',
        projectId: 'project-link'
      }
    ],
    nextOffset: null
  })
  expect(state.getProject).toHaveBeenCalledWith('project-link', 'team-a')
})

it('indexes an SSH artifact only for the source session connection and checks remote existence', async () => {
  state.getSession.mockResolvedValue({
    id: 'session-ssh',
    project_id: null,
    ssh_connection_id: 'connection-1'
  })
  state.statSshRuntimePath.mockResolvedValue({ exists: true, type: 'file' })
  state.request.mockResolvedValue([
    {
      runId: 'run-ssh',
      seq: 1,
      data: {
        toolCallId: 'write-remote',
        kind: 'file',
        transport: 'ssh',
        connectionId: 'connection-1',
        path: '/reports/summary.pdf',
        operation: 'create'
      },
      timestamp: 12,
      sessionId: 'session-ssh',
      status: 'completed',
      projectId: null
    },
    {
      runId: 'run-ssh',
      seq: 2,
      data: {
        toolCallId: 'write-other-connection',
        kind: 'file',
        transport: 'ssh',
        connectionId: 'connection-other',
        path: '/reports/private.pdf',
        operation: 'create'
      },
      timestamp: 13,
      sessionId: 'session-ssh',
      status: 'completed',
      projectId: null
    }
  ])
  const result = await invoke('execution-artifacts:list', {
    workspaceId: 'team-a',
    category: 'document'
  })
  expect(result).toMatchObject({
    artifacts: [
      {
        kind: 'file',
        transport: 'ssh',
        connectionId: 'connection-1',
        path: '/reports/summary.pdf',
        exists: true
      }
    ],
    nextOffset: null
  })
  expect(state.statSshRuntimePath).toHaveBeenCalledTimes(1)
  expect(state.statSshRuntimePath).toHaveBeenCalledWith(
    'team-a',
    'connection-1',
    '/reports/summary.pdf'
  )
})

it('hides only a confirmed artifact owned by the current window workspace', async () => {
  expect(
    await invoke('execution-artifacts:hide', {
      workspaceId: 'team-b',
      runId: 'run-1',
      seq: 4
    })
  ).toMatchObject({ hidden: false, error: 'WINDOW_WORKSPACE_MISMATCH' })
  expect(state.request).not.toHaveBeenCalled()

  expect(
    await invoke('execution-artifacts:hide', {
      workspaceId: 'team-a',
      runId: 'run-1',
      seq: 0
    })
  ).toMatchObject({ hidden: false, error: 'INVALID_ARTIFACT_ID' })

  state.request.mockResolvedValue({ hidden: true })
  expect(
    await invoke('execution-artifacts:hide', {
      workspaceId: 'team-a',
      runId: 'run-1',
      seq: 4
    })
  ).toEqual({ hidden: true })
  expect(state.request).toHaveBeenCalledWith('artifact.hide', {
    workspaceId: 'team-a',
    runId: 'run-1',
    seq: 4
  })
})

it('retains the linked task title when the task has since been removed', async () => {
  state.getSession.mockResolvedValue({ id: 'session-1', title: 'Parent session' })
  state.getTask.mockResolvedValue(undefined)
  state.request.mockImplementation(async (method) =>
    method === 'run.list'
      ? [
          {
            ...teamRun,
            businessTaskId: 'business-task-1',
            businessTaskTitle: 'Original task name',
            status: 'completed',
            createdAt: 10,
            updatedAt: 20
          }
        ]
      : { events: [], pendingInteractions: [] }
  )
  const result = await invoke('execution-records:list', { workspaceId: 'team-a' })
  expect(result).toMatchObject({
    records: [
      {
        title: 'Original task name',
        businessTaskId: 'business-task-1',
        workspaceId: 'team-a'
      }
    ]
  })
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

it('accepts a linked business task only when it belongs to the same session and workspace', async () => {
  state.getSession.mockResolvedValue({ id: 'session-1', workspace_id: 'team-a' })
  state.request.mockResolvedValue({ runId: 'run-1' })
  state.getTask.mockResolvedValue({ id: 'business-task-1', session_id: 'other-session' })
  const linked = { ...teamRun, businessTaskId: 'business-task-1', businessTaskTitle: 'Spoofed' }
  expect(await invoke('ts-runtime:run-submit', linked)).toMatchObject({
    accepted: false,
    error: 'TASK_SESSION_WORKSPACE_MISMATCH'
  })
  expect(state.request).not.toHaveBeenCalledWith('run.submit', expect.anything())
  expect(state.getTask).toHaveBeenCalledWith('business-task-1', 'team-a')

  state.getTask.mockResolvedValue({
    id: 'business-task-1',
    session_id: 'session-1',
    subject: 'Review task'
  })
  expect(await invoke('ts-runtime:run-submit', linked)).toMatchObject({ accepted: true })
  expect(state.request).toHaveBeenCalledWith(
    'run.submit',
    expect.objectContaining({ ...linked, businessTaskTitle: 'Review task' })
  )
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
