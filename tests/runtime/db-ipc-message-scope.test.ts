import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, bytes: Uint8Array) => Promise<unknown>>(),
  available: new Set(['team-a']),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  deleteSession: vi.fn(),
  clearAllSessions: vi.fn(),
  getMessages: vi.fn(),
  getUserMessages: vi.fn(),
  getMessageMarkers: vi.fn(),
  getMessageLocatorRows: vi.fn(),
  getMessagesPage: vi.fn(),
  getMessagesRequestContext: vi.fn(),
  getMessagesWindowAround: vi.fn(),
  searchMessageContent: vi.fn(),
  addMessages: vi.fn(),
  insertMessageArtifacts: vi.fn(),
  upsertMessage: vi.fn(),
  updateMessage: vi.fn(),
  clearMessages: vi.fn(),
  deleteMessage: vi.fn(),
  replaceMessages: vi.fn(),
  truncateMessagesFrom: vi.fn(),
  getMessageCount: vi.fn(),
  listProjects: vi.fn(),
  getProject: vi.fn(),
  createProject: vi.fn(),
  ensureDefaultProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  listPlans: vi.fn(),
  getPlan: vi.fn(),
  getPlanBySession: vi.fn(),
  createPlan: vi.fn(),
  updatePlan: vi.fn(),
  deletePlan: vi.fn(),
  listAllTasks: vi.fn(),
  listTasksBySession: vi.fn(),
  getTask: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  deleteTasksBySession: vi.fn(),
  listGoals: vi.fn(),
  getGoal: vi.fn(),
  createGoal: vi.fn(),
  replaceGoal: vi.fn(),
  updateGoal: vi.fn(),
  clearGoal: vi.fn(),
  accountGoalUsage: vi.fn(),
  listGoalEvents: vi.fn(),
  addGoalEvent: vi.fn(),
  listDrawRuns: vi.fn(),
  saveDrawRun: vi.fn(),
  deleteDrawRun: vi.fn(),
  clearDrawRuns: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (_event: unknown, bytes: Uint8Array) => Promise<unknown>) =>
      state.handlers.set(channel, handler)
  },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../src/main/db/database', () => ({ initializeDatabase: async () => undefined }))
vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: async () => state.available
}))
vi.mock('../../src/main/db/sessions-dao', () => ({
  getSession: state.getSession,
  listSessions: state.listSessions,
  createSession: state.createSession,
  updateSession: state.updateSession,
  deleteSession: state.deleteSession,
  clearAllSessions: state.clearAllSessions
}))
vi.mock('../../src/main/db/messages-dao', () => ({
  getMessages: state.getMessages,
  getUserMessages: state.getUserMessages,
  getMessageMarkers: state.getMessageMarkers,
  getMessageLocatorRows: state.getMessageLocatorRows,
  getMessagesPage: state.getMessagesPage,
  getMessagesRequestContext: state.getMessagesRequestContext,
  getMessagesWindowAround: state.getMessagesWindowAround,
  searchMessageContent: state.searchMessageContent,
  addMessages: state.addMessages,
  insertMessageArtifacts: state.insertMessageArtifacts,
  upsertMessage: state.upsertMessage,
  updateMessage: state.updateMessage,
  clearMessages: state.clearMessages,
  deleteMessage: state.deleteMessage,
  replaceMessages: state.replaceMessages,
  truncateMessagesFrom: state.truncateMessagesFrom,
  getMessageCount: state.getMessageCount
}))
vi.mock('../../src/main/db/projects-dao', () => ({
  listProjects: state.listProjects,
  getProject: state.getProject,
  createProject: state.createProject,
  ensureDefaultProject: state.ensureDefaultProject,
  updateProject: state.updateProject,
  deleteProject: state.deleteProject
}))
vi.mock('../../src/main/db/plans-dao', () => ({
  listPlans: state.listPlans,
  getPlan: state.getPlan,
  getPlanBySession: state.getPlanBySession,
  createPlan: state.createPlan,
  updatePlan: state.updatePlan,
  deletePlan: state.deletePlan
}))
vi.mock('../../src/main/db/tasks-dao', () => ({
  listAllTasks: state.listAllTasks,
  listTasksBySession: state.listTasksBySession,
  getTask: state.getTask,
  createTask: state.createTask,
  updateTask: state.updateTask,
  deleteTask: state.deleteTask,
  deleteTasksBySession: state.deleteTasksBySession
}))
vi.mock('../../src/main/db/goals-dao', () => ({
  listGoals: state.listGoals,
  getGoal: state.getGoal,
  createGoal: state.createGoal,
  replaceGoal: state.replaceGoal,
  updateGoal: state.updateGoal,
  clearGoal: state.clearGoal,
  accountGoalUsage: state.accountGoalUsage,
  listGoalEvents: state.listGoalEvents,
  addGoalEvent: state.addGoalEvent
}))
vi.mock('../../src/main/goals/goal-runtime', () => ({
  getGoalRuntimeService: () => ({ handleGoalMutation: vi.fn() })
}))
vi.mock('../../src/main/goals/goal-sync', () => ({
  emitGoalCleared: vi.fn(),
  emitGoalEventAdded: vi.fn(),
  emitGoalUpdated: vi.fn()
}))
vi.mock('../../src/main/db/draw-runs-dao', () => ({
  listDrawRuns: state.listDrawRuns,
  saveDrawRun: state.saveDrawRun,
  deleteDrawRun: state.deleteDrawRun,
  clearDrawRuns: state.clearDrawRuns
}))

import { registerDbHandlers } from '../../src/main/ipc/db-handlers'
import {
  DB_MESSAGES_LIST_MSGPACK_CHANNEL,
  DB_MESSAGES_LIST_USER_MSGPACK_CHANNEL,
  DB_MESSAGES_LIST_MARKERS_MSGPACK_CHANNEL,
  DB_MESSAGES_LIST_LOCATOR_MSGPACK_CHANNEL,
  DB_MESSAGES_LIST_PAGE_MSGPACK_CHANNEL,
  DB_MESSAGES_REQUEST_CONTEXT_MSGPACK_CHANNEL,
  DB_MESSAGES_WINDOW_AROUND_MSGPACK_CHANNEL,
  DB_MESSAGES_SEARCH_CONTENT_MSGPACK_CHANNEL,
  DB_MESSAGES_ADD_BATCH_MSGPACK_CHANNEL,
  DB_MESSAGES_INSERT_ARTIFACTS_MSGPACK_CHANNEL,
  DB_MESSAGES_UPSERT_MSGPACK_CHANNEL,
  DB_MESSAGES_UPDATE_MSGPACK_CHANNEL,
  DB_MESSAGES_CLEAR_MSGPACK_CHANNEL,
  DB_MESSAGES_DELETE_MSGPACK_CHANNEL,
  DB_MESSAGES_REPLACE_MSGPACK_CHANNEL,
  DB_MESSAGES_TRUNCATE_FROM_MSGPACK_CHANNEL,
  DB_MESSAGES_COUNT_MSGPACK_CHANNEL,
  DB_GOALS_LIST_MSGPACK_CHANNEL,
  DB_GOALS_GET_MSGPACK_CHANNEL,
  DB_GOALS_CREATE_MSGPACK_CHANNEL,
  DB_GOALS_SET_MSGPACK_CHANNEL,
  DB_GOALS_UPDATE_MSGPACK_CHANNEL,
  DB_GOALS_CLEAR_MSGPACK_CHANNEL,
  DB_GOALS_ACCOUNT_MSGPACK_CHANNEL,
  DB_GOAL_EVENTS_ADD_MSGPACK_CHANNEL,
  DB_GOAL_EVENTS_LIST_MSGPACK_CHANNEL,
  DB_PLANS_LIST_MSGPACK_CHANNEL,
  DB_PLANS_CREATE_MSGPACK_CHANNEL,
  DB_PROJECTS_GET_MSGPACK_CHANNEL,
  DB_PROJECTS_CREATE_MSGPACK_CHANNEL,
  DB_PROJECTS_ENSURE_DEFAULT_MSGPACK_CHANNEL,
  DB_PROJECTS_LIST_MSGPACK_CHANNEL,
  DB_PROJECTS_UPDATE_MSGPACK_CHANNEL,
  DB_PROJECTS_DELETE_MSGPACK_CHANNEL,
  DB_PLANS_GET_MSGPACK_CHANNEL,
  DB_PLANS_GET_BY_SESSION_MSGPACK_CHANNEL,
  DB_PLANS_UPDATE_MSGPACK_CHANNEL,
  DB_PLANS_DELETE_MSGPACK_CHANNEL,
  DB_SESSIONS_GET_MSGPACK_CHANNEL,
  DB_SESSIONS_CREATE_MSGPACK_CHANNEL,
  DB_SESSIONS_DELETE_MSGPACK_CHANNEL,
  DB_SESSIONS_CLEAR_ALL_MSGPACK_CHANNEL,
  DB_SESSIONS_LIST_MSGPACK_CHANNEL,
  DB_SESSIONS_UPDATE_MSGPACK_CHANNEL,
  DB_TASKS_LIST_ALL_MSGPACK_CHANNEL,
  DB_TASKS_LIST_BY_SESSION_MSGPACK_CHANNEL,
  DB_TASKS_GET_MSGPACK_CHANNEL,
  DB_TASKS_CREATE_MSGPACK_CHANNEL,
  DB_TASKS_UPDATE_MSGPACK_CHANNEL,
  DB_TASKS_DELETE_MSGPACK_CHANNEL,
  DB_TASKS_DELETE_BY_SESSION_MSGPACK_CHANNEL,
  DB_DRAW_RUNS_LIST_MSGPACK_CHANNEL,
  DB_DRAW_RUNS_SAVE_MSGPACK_CHANNEL,
  DB_DRAW_RUNS_DELETE_MSGPACK_CHANNEL,
  DB_DRAW_RUNS_CLEAR_MSGPACK_CHANNEL,
  encodeMessagePackPayload,
  decodeMessagePackPayload
} from '../../src/shared/messagepack/binary-ipc'

beforeEach(async () => {
  state.handlers.clear()
  state.available = new Set(['team-a'])
  state.getSession.mockReset()
  state.listSessions.mockReset()
  state.createSession.mockReset()
  state.updateSession.mockReset()
  state.deleteSession.mockReset()
  state.clearAllSessions.mockReset()
  state.getMessages.mockReset()
  state.getUserMessages.mockReset()
  state.getMessageMarkers.mockReset()
  state.getMessageLocatorRows.mockReset()
  state.getMessagesPage.mockReset()
  state.getMessagesRequestContext.mockReset()
  state.getMessagesWindowAround.mockReset()
  state.searchMessageContent.mockReset()
  state.addMessages.mockReset()
  state.insertMessageArtifacts.mockReset()
  state.upsertMessage.mockReset()
  state.updateMessage.mockReset()
  state.clearMessages.mockReset()
  state.deleteMessage.mockReset()
  state.replaceMessages.mockReset()
  state.truncateMessagesFrom.mockReset()
  state.getMessageCount.mockReset()
  state.listProjects.mockReset()
  state.getProject.mockReset()
  state.createProject.mockReset()
  state.ensureDefaultProject.mockReset()
  state.updateProject.mockReset()
  state.deleteProject.mockReset()
  state.listPlans.mockReset()
  state.getPlan.mockReset()
  state.getPlanBySession.mockReset()
  state.createPlan.mockReset()
  state.updatePlan.mockReset()
  state.deletePlan.mockReset()
  state.listAllTasks.mockReset()
  state.listTasksBySession.mockReset()
  state.getTask.mockReset()
  state.createTask.mockReset()
  state.updateTask.mockReset()
  state.deleteTask.mockReset()
  state.deleteTasksBySession.mockReset()
  state.listGoals.mockReset()
  state.getGoal.mockReset()
  state.createGoal.mockReset()
  state.replaceGoal.mockReset()
  state.updateGoal.mockReset()
  state.clearGoal.mockReset()
  state.accountGoalUsage.mockReset()
  state.listGoalEvents.mockReset()
  state.addGoalEvent.mockReset()
  state.listDrawRuns.mockReset()
  state.saveDrawRun.mockReset()
  state.deleteDrawRun.mockReset()
  state.clearDrawRuns.mockReset()
  await registerDbHandlers()
})

it('routes the complete Goal lifecycle and event journal through TS DAOs', async () => {
  state.getSession.mockResolvedValue({ id: 'session-a', workspace_id: 'team-a' })
  const goal = {
    session_id: 'session-a',
    goal_id: 'goal-a',
    objective: 'Ship it',
    status: 'active',
    token_budget: null,
    tokens_used: 0,
    time_used_seconds: 0,
    created_at: 1,
    updated_at: 1
  }
  state.getGoal.mockResolvedValue(goal)
  state.replaceGoal.mockResolvedValue(goal)
  state.updateGoal.mockResolvedValue({ ...goal, status: 'paused' })
  state.clearGoal.mockResolvedValue(true)
  state.accountGoalUsage.mockResolvedValue({ ...goal, tokens_used: 3 })
  state.listGoalEvents.mockResolvedValue([])
  state.addGoalEvent.mockResolvedValue({
    id: 'event-a',
    session_id: 'session-a',
    goal_id: 'goal-a',
    event_type: 'created',
    message: null,
    metadata_json: null,
    created_at: 1
  })

  await call(DB_GOALS_SET_MSGPACK_CHANNEL, {
    sessionId: 'session-a',
    workspaceId: 'team-a',
    objective: 'Ship it'
  })
  await call(DB_GOALS_UPDATE_MSGPACK_CHANNEL, {
    sessionId: 'session-a',
    workspaceId: 'team-a',
    patch: { status: 'paused' }
  })
  await call(DB_GOALS_CLEAR_MSGPACK_CHANNEL, { sessionId: 'session-a', workspaceId: 'team-a' })
  await call(DB_GOALS_ACCOUNT_MSGPACK_CHANNEL, {
    sessionId: 'session-a',
    workspaceId: 'team-a',
    timeDeltaSeconds: 2,
    tokenDelta: 3
  })
  await call(DB_GOAL_EVENTS_LIST_MSGPACK_CHANNEL, { sessionId: 'session-a', workspaceId: 'team-a' })
  await call(DB_GOAL_EVENTS_ADD_MSGPACK_CHANNEL, {
    sessionId: 'session-a',
    workspaceId: 'team-a',
    eventType: 'created'
  })

  expect(state.replaceGoal).toHaveBeenCalled()
  expect(state.updateGoal).toHaveBeenCalledWith('session-a', { status: 'paused' }, 'team-a')
  expect(state.clearGoal).toHaveBeenCalledWith('session-a', 'team-a')
  expect(state.accountGoalUsage).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'session-a', workspaceId: 'team-a', tokenDelta: 3 })
  )
  expect(state.listGoalEvents).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'session-a', workspaceId: 'team-a' })
  )
  expect(state.addGoalEvent).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'session-a', workspaceId: 'team-a', eventType: 'created' })
  )
})

it('routes the complete Session lifecycle through the workspace-scoped TS DAO', async () => {
  const session = { id: 'session-a', workspace_id: 'team-a', title: 'Session' }
  state.listSessions.mockResolvedValue([session])
  state.getSession.mockResolvedValue(session)
  state.getMessages.mockResolvedValue([])
  state.clearAllSessions.mockResolvedValue({ sessionIds: ['session-a'] })

  await call(DB_SESSIONS_LIST_MSGPACK_CHANNEL, { workspaceId: 'team-a' })
  await call(DB_SESSIONS_GET_MSGPACK_CHANNEL, { id: 'session-a', workspaceId: 'team-a' })
  await call(DB_SESSIONS_CREATE_MSGPACK_CHANNEL, {
    id: 'session-a',
    title: 'Session',
    mode: 'chat',
    createdAt: 1,
    updatedAt: 1,
    workspaceId: 'team-a'
  })
  await call(DB_SESSIONS_UPDATE_MSGPACK_CHANNEL, {
    id: 'session-a',
    workspaceId: 'team-a',
    patch: { title: 'Updated' }
  })
  await call(DB_SESSIONS_DELETE_MSGPACK_CHANNEL, { id: 'session-a', workspaceId: 'team-a' })
  await call(DB_SESSIONS_CLEAR_ALL_MSGPACK_CHANNEL, { workspaceId: 'team-a' })

  expect(state.listSessions).toHaveBeenCalledWith(undefined, undefined, 'team-a')
  expect(state.getSession).toHaveBeenCalledWith('session-a', 'team-a')
  expect(state.getMessages).toHaveBeenCalledWith('session-a', 'team-a')
  expect(state.createSession).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: 'team-a' })
  )
  expect(state.updateSession).toHaveBeenCalledWith('session-a', 'team-a', { title: 'Updated' })
  expect(state.deleteSession).toHaveBeenCalledWith('session-a', 'team-a')
  expect(state.clearAllSessions).toHaveBeenCalledWith('team-a')
})

it('routes message read and search queries through workspace-scoped TS DAOs', async () => {
  state.getSession.mockResolvedValue({ id: 'session-a', workspace_id: 'team-a' })
  state.getMessages.mockResolvedValue([{ id: 'message-a' }])
  state.getUserMessages.mockResolvedValue([{ id: 'message-user' }])
  state.getMessageMarkers.mockResolvedValue([{ id: 'marker-a' }])
  state.getMessageLocatorRows.mockResolvedValue([{ id: 'locator-a' }])
  state.getMessagesPage.mockResolvedValue([{ id: 'page-a' }])
  state.getMessagesRequestContext.mockResolvedValue([{ id: 'context-a' }])
  state.getMessagesWindowAround.mockResolvedValue({ before: [], target: null, after: [] })
  state.searchMessageContent.mockResolvedValue([{ id: 'match-a', session_id: 'session-a' }])

  await call(DB_MESSAGES_LIST_MSGPACK_CHANNEL, { sessionId: 'session-a', workspaceId: 'team-a' })
  await call(DB_MESSAGES_LIST_USER_MSGPACK_CHANNEL, {
    sessionId: 'session-a',
    workspaceId: 'team-a'
  })
  await call(DB_MESSAGES_LIST_MARKERS_MSGPACK_CHANNEL, {
    sessionId: 'session-a',
    workspaceId: 'team-a'
  })
  await call(DB_MESSAGES_LIST_LOCATOR_MSGPACK_CHANNEL, {
    sessionId: 'session-a',
    workspaceId: 'team-a'
  })
  await call(DB_MESSAGES_LIST_PAGE_MSGPACK_CHANNEL, {
    sessionId: 'session-a',
    workspaceId: 'team-a',
    limit: 20,
    offset: 5
  })
  await call(DB_MESSAGES_REQUEST_CONTEXT_MSGPACK_CHANNEL, {
    sessionId: 'session-a',
    workspaceId: 'team-a',
    maxMessages: 10,
    headLimit: 2
  })
  await call(DB_MESSAGES_WINDOW_AROUND_MSGPACK_CHANNEL, {
    sessionId: 'session-a',
    workspaceId: 'team-a',
    messageId: 'message-a',
    limit: 5
  })
  await call(DB_MESSAGES_SEARCH_CONTENT_MSGPACK_CHANNEL, {
    query: 'needle',
    limit: 10,
    workspaceId: 'team-a'
  })

  expect(state.getMessages).toHaveBeenCalledWith('session-a', 'team-a')
  expect(state.getUserMessages).toHaveBeenCalledWith('session-a', 'team-a')
  expect(state.getMessageMarkers).toHaveBeenCalledWith('session-a', 'team-a')
  expect(state.getMessageLocatorRows).toHaveBeenCalledWith('session-a', 'team-a')
  expect(state.getMessagesPage).toHaveBeenCalledWith('session-a', 20, 5, 'team-a')
  expect(state.getMessagesRequestContext).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'session-a', workspaceId: 'team-a', maxMessages: 10 })
  )
  expect(state.getMessagesWindowAround).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'session-a', workspaceId: 'team-a', limit: 5 })
  )
  expect(state.searchMessageContent).toHaveBeenCalledWith('needle', 10, 'team-a')
})

it('routes message writes and lifecycle mutations through TS DAOs', async () => {
  state.getSession.mockResolvedValue({ id: 'session-a', workspace_id: 'team-a' })
  state.deleteMessage.mockResolvedValue(true)
  state.getMessageCount.mockResolvedValue(3)
  state.insertMessageArtifacts.mockResolvedValue({ success: true })

  const message = {
    id: 'message-a',
    sessionId: 'session-a',
    workspaceId: 'team-a',
    role: 'user',
    content: 'hello',
    createdAt: 1,
    sortOrder: 0
  }
  await call(DB_MESSAGES_ADD_BATCH_MSGPACK_CHANNEL, [message])
  await call(DB_MESSAGES_INSERT_ARTIFACTS_MSGPACK_CHANNEL, {
    sessionId: 'session-a',
    workspaceId: 'team-a',
    artifacts: []
  })
  await call(DB_MESSAGES_UPSERT_MSGPACK_CHANNEL, message)
  await call(DB_MESSAGES_UPDATE_MSGPACK_CHANNEL, {
    id: 'message-a',
    sessionId: 'session-a',
    workspaceId: 'team-a',
    patch: { content: 'updated' }
  })
  await call(DB_MESSAGES_CLEAR_MSGPACK_CHANNEL, { sessionId: 'session-a', workspaceId: 'team-a' })
  await call(DB_MESSAGES_DELETE_MSGPACK_CHANNEL, {
    sessionId: 'session-a',
    messageId: 'message-a',
    workspaceId: 'team-a'
  })
  await call(DB_MESSAGES_REPLACE_MSGPACK_CHANNEL, {
    sessionId: 'session-a',
    workspaceId: 'team-a',
    messages: [message]
  })
  await call(DB_MESSAGES_TRUNCATE_FROM_MSGPACK_CHANNEL, {
    sessionId: 'session-a',
    workspaceId: 'team-a',
    fromSortOrder: 0
  })
  await call(DB_MESSAGES_COUNT_MSGPACK_CHANNEL, { sessionId: 'session-a', workspaceId: 'team-a' })

  expect(state.addMessages).toHaveBeenCalledWith([message])
  expect(state.insertMessageArtifacts).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'session-a', workspaceId: 'team-a' })
  )
  expect(state.upsertMessage).toHaveBeenCalledWith(message)
  expect(state.updateMessage).toHaveBeenCalledWith('message-a', { content: 'updated' }, 'team-a')
  expect(state.clearMessages).toHaveBeenCalledWith('session-a', 'team-a')
  expect(state.deleteMessage).toHaveBeenCalledWith('session-a', 'message-a', 'team-a')
  expect(state.replaceMessages).toHaveBeenCalledWith('session-a', [message], 'team-a')
  expect(state.truncateMessagesFrom).toHaveBeenCalledWith('session-a', 0, 'team-a')
  expect(state.getMessageCount).toHaveBeenCalledWith('session-a', 'team-a')
})

it('routes Draw run persistence through the TS workspace-scoped DAO', async () => {
  state.listDrawRuns.mockResolvedValue([{ id: 'draw-a', workspace_id: 'team-a' }])
  await expect(call(DB_DRAW_RUNS_LIST_MSGPACK_CHANNEL, 'team-a')).resolves.toBeDefined()
  expect(state.listDrawRuns).toHaveBeenCalledWith('team-a')

  const run = {
    id: 'draw-a',
    workspaceId: 'team-a',
    prompt: 'sunset',
    providerName: 'local',
    modelName: 'image-model',
    createdAt: 1,
    updatedAt: 1,
    isGenerating: false,
    imagesJson: '[]'
  }
  await call(DB_DRAW_RUNS_SAVE_MSGPACK_CHANNEL, run)
  await call(DB_DRAW_RUNS_DELETE_MSGPACK_CHANNEL, { id: 'draw-a', workspaceId: 'team-a' })
  await call(DB_DRAW_RUNS_CLEAR_MSGPACK_CHANNEL, 'team-a')
  expect(state.saveDrawRun).toHaveBeenCalledWith(run)
  expect(state.deleteDrawRun).toHaveBeenCalledWith('draw-a', 'team-a')
  expect(state.clearDrawRuns).toHaveBeenCalledWith('team-a')
})

it('requires a workspace and session ownership for Goal reads and writes', async () => {
  await expect(call(DB_GOALS_LIST_MSGPACK_CHANNEL, {})).rejects.toThrow('db-workspace-required')
  await expect(call(DB_GOALS_GET_MSGPACK_CHANNEL, 'session-a')).rejects.toThrow(
    'db-workspace-required'
  )
  await expect(
    call(DB_GOALS_CREATE_MSGPACK_CHANNEL, { sessionId: 'session-a', objective: 'Private' })
  ).rejects.toThrow('db-workspace-required')
  state.getSession.mockResolvedValue(null)
  await expect(
    call(DB_GOALS_GET_MSGPACK_CHANNEL, { sessionId: 'session-a', workspaceId: 'team-a' })
  ).rejects.toThrow('session-workspace-mismatch')
  expect(state.listGoals).not.toHaveBeenCalled()
  expect(state.getGoal).not.toHaveBeenCalled()
  expect(state.createGoal).not.toHaveBeenCalled()
})

it('stops a Goal mutation if team membership is revoked during session lookup', async () => {
  state.getSession.mockImplementation(async () => {
    state.available = new Set()
    return { id: 'session-a', workspace_id: 'team-a' }
  })
  await expect(
    call(DB_GOALS_CREATE_MSGPACK_CHANNEL, {
      sessionId: 'session-a',
      workspaceId: 'team-a',
      objective: 'Should not be written'
    })
  ).rejects.toThrow('db-workspace-unavailable')
  expect(state.getGoal).not.toHaveBeenCalled()
  expect(state.createGoal).not.toHaveBeenCalled()
})

it('stops a Goal mutation if membership is revoked while loading the previous Goal', async () => {
  state.getSession.mockResolvedValue({ id: 'session-a', workspace_id: 'team-a' })
  state.getGoal.mockImplementation(async () => {
    state.available = new Set()
    return null
  })
  await expect(
    call(DB_GOALS_CREATE_MSGPACK_CHANNEL, {
      sessionId: 'session-a',
      workspaceId: 'team-a',
      objective: 'Should not be written'
    })
  ).rejects.toThrow('db-workspace-unavailable')
  expect(state.createGoal).not.toHaveBeenCalled()
})

it('passes the authorized workspace to the Goal repository', async () => {
  state.listGoals.mockResolvedValue([{ session_id: 'team-session', objective: 'Team private' }])
  const result = await call(DB_GOALS_LIST_MSGPACK_CHANNEL, { workspaceId: 'team-a' })
  expect(state.listGoals).toHaveBeenCalledWith('team-a')
  expect(decodeMessagePackPayload(result as Uint8Array)).toEqual([
    { session_id: 'team-session', objective: 'Team private' }
  ])
})

it('routes project, plan, and task lifecycle through workspace-scoped TS DAOs', async () => {
  state.getSession.mockResolvedValue({ id: 'session-a', workspace_id: 'team-a' })
  state.listProjects.mockResolvedValue([{ id: 'project-a', workspace_id: 'team-a' }])
  state.getProject.mockResolvedValue({ id: 'project-a', workspace_id: 'team-a' })
  state.ensureDefaultProject.mockResolvedValue({ id: 'default-project', workspace_id: 'team-a' })
  state.createProject.mockResolvedValue({ id: 'project-a', workspace_id: 'team-a' })
  state.deleteProject.mockResolvedValue({ sessionIds: [] })
  state.listPlans.mockResolvedValue([{ id: 'plan-a', workspace_id: 'team-a' }])
  state.getPlan.mockResolvedValue({ id: 'plan-a', workspace_id: 'team-a' })
  state.getPlanBySession.mockResolvedValue({ id: 'plan-a', session_id: 'session-a' })
  state.listAllTasks.mockResolvedValue([{ id: 'task-a', workspace_id: 'team-a' }])
  state.listTasksBySession.mockResolvedValue([{ id: 'task-a', session_id: 'session-a' }])
  state.getTask.mockResolvedValue({ id: 'task-a', workspace_id: 'team-a' })

  await call(DB_PROJECTS_LIST_MSGPACK_CHANNEL, { workspaceId: 'team-a' })
  await call(DB_PROJECTS_GET_MSGPACK_CHANNEL, { id: 'project-a', workspaceId: 'team-a' })
  await call(DB_PROJECTS_ENSURE_DEFAULT_MSGPACK_CHANNEL, { workspaceId: 'team-a' })
  await call(DB_PROJECTS_CREATE_MSGPACK_CHANNEL, { name: 'Project', workspaceId: 'team-a' })
  await call(DB_PROJECTS_UPDATE_MSGPACK_CHANNEL, {
    id: 'project-a',
    workspaceId: 'team-a',
    patch: { name: 'Updated' }
  })
  await call(DB_PROJECTS_DELETE_MSGPACK_CHANNEL, { id: 'project-a', workspaceId: 'team-a' })

  await call(DB_PLANS_LIST_MSGPACK_CHANNEL, { workspaceId: 'team-a' })
  await call(DB_PLANS_GET_MSGPACK_CHANNEL, { id: 'plan-a', workspaceId: 'team-a' })
  await call(DB_PLANS_GET_BY_SESSION_MSGPACK_CHANNEL, {
    sessionId: 'session-a',
    workspaceId: 'team-a'
  })
  await call(DB_PLANS_CREATE_MSGPACK_CHANNEL, {
    id: 'plan-a',
    sessionId: 'session-a',
    title: 'Plan',
    createdAt: 1,
    updatedAt: 1,
    workspaceId: 'team-a'
  })
  await call(DB_PLANS_UPDATE_MSGPACK_CHANNEL, {
    id: 'plan-a',
    workspaceId: 'team-a',
    patch: { title: 'Updated' }
  })
  await call(DB_PLANS_DELETE_MSGPACK_CHANNEL, { id: 'plan-a', workspaceId: 'team-a' })

  await call(DB_TASKS_LIST_ALL_MSGPACK_CHANNEL, { workspaceId: 'team-a' })
  await call(DB_TASKS_LIST_BY_SESSION_MSGPACK_CHANNEL, {
    sessionId: 'session-a',
    workspaceId: 'team-a'
  })
  await call(DB_TASKS_GET_MSGPACK_CHANNEL, { id: 'task-a', workspaceId: 'team-a' })
  await call(DB_TASKS_CREATE_MSGPACK_CHANNEL, {
    id: 'task-a',
    sessionId: 'session-a',
    workspaceId: 'team-a',
    subject: 'Task',
    description: '',
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1
  })
  await call(DB_TASKS_UPDATE_MSGPACK_CHANNEL, {
    id: 'task-a',
    workspaceId: 'team-a',
    patch: { subject: 'Updated' }
  })
  await call(DB_TASKS_DELETE_MSGPACK_CHANNEL, { id: 'task-a', workspaceId: 'team-a' })
  await call(DB_TASKS_DELETE_BY_SESSION_MSGPACK_CHANNEL, {
    sessionId: 'session-a',
    workspaceId: 'team-a'
  })

  expect(state.listProjects).toHaveBeenCalledWith('team-a')
  expect(state.getProject).toHaveBeenCalledWith('project-a', 'team-a')
  expect(state.ensureDefaultProject).toHaveBeenCalledWith('team-a')
  expect(state.createProject).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: 'team-a' })
  )
  expect(state.updateProject).toHaveBeenCalledWith('project-a', 'team-a', { name: 'Updated' })
  expect(state.deleteProject).toHaveBeenCalledWith('project-a', 'team-a')
  expect(state.getPlan).toHaveBeenCalledWith('plan-a', 'team-a')
  expect(state.getPlanBySession).toHaveBeenCalledWith('session-a', 'team-a')
  expect(state.updatePlan).toHaveBeenCalledWith('plan-a', 'team-a', { title: 'Updated' })
  expect(state.deletePlan).toHaveBeenCalledWith('plan-a', 'team-a')
  expect(state.listTasksBySession).toHaveBeenCalledWith('session-a', 'team-a')
  expect(state.getTask).toHaveBeenCalledWith('task-a', 'team-a')
  expect(state.updateTask).toHaveBeenCalledWith('task-a', 'team-a', { subject: 'Updated' })
  expect(state.deleteTask).toHaveBeenCalledWith('task-a', 'team-a')
  expect(state.deleteTasksBySession).toHaveBeenCalledWith('session-a', 'team-a')
})

function call(channel: string, input: unknown): Promise<unknown> {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
  return handler({}, encodeMessagePackPayload(input))
}

it('rejects unscoped session and message reads before accessing storage', async () => {
  await expect(call(DB_SESSIONS_LIST_MSGPACK_CHANNEL, null)).rejects.toThrow(
    'db-workspace-required'
  )
  await expect(call(DB_SESSIONS_GET_MSGPACK_CHANNEL, 'session-a')).rejects.toThrow(
    'db-workspace-required'
  )
  await expect(call(DB_MESSAGES_LIST_MSGPACK_CHANNEL, 'session-a')).rejects.toThrow(
    'db-workspace-required'
  )
  expect(state.listSessions).not.toHaveBeenCalled()
  expect(state.getSession).not.toHaveBeenCalled()
  expect(state.getMessages).not.toHaveBeenCalled()
})

it('rejects a team read if offline membership is revoked during storage access', async () => {
  state.getSession.mockResolvedValue({ id: 'session-a', workspace_id: 'team-a' })
  state.getMessages.mockImplementation(async () => {
    state.available = new Set()
    return [{ id: 'message-a' }]
  })
  await expect(
    call(DB_MESSAGES_LIST_MSGPACK_CHANNEL, { sessionId: 'session-a', workspaceId: 'team-a' })
  ).rejects.toThrow('db-workspace-unavailable')
})

it('requires an explicit workspace for project, plan, and task reads', async () => {
  await expect(call(DB_PROJECTS_LIST_MSGPACK_CHANNEL, null)).rejects.toThrow(
    'db-workspace-required'
  )
  await expect(call(DB_PROJECTS_GET_MSGPACK_CHANNEL, 'project-a')).rejects.toThrow(
    'db-workspace-required'
  )
  await expect(call(DB_PLANS_LIST_MSGPACK_CHANNEL, null)).rejects.toThrow('db-workspace-required')
  await expect(call(DB_TASKS_LIST_ALL_MSGPACK_CHANNEL, null)).rejects.toThrow(
    'db-workspace-required'
  )
  expect(state.listProjects).not.toHaveBeenCalled()
  expect(state.getProject).not.toHaveBeenCalled()
  expect(state.listPlans).not.toHaveBeenCalled()
  expect(state.listAllTasks).not.toHaveBeenCalled()
})

it('withholds project results when a team loses offline authorization mid-read', async () => {
  state.listProjects.mockImplementation(async () => {
    state.available = new Set()
    return [{ id: 'project-a', workspace_id: 'team-a' }]
  })
  await expect(call(DB_PROJECTS_LIST_MSGPACK_CHANNEL, { workspaceId: 'team-a' })).rejects.toThrow(
    'db-workspace-unavailable'
  )
})

it('blocks unscoped project and session mutations before native storage', async () => {
  await expect(call(DB_PROJECTS_ENSURE_DEFAULT_MSGPACK_CHANNEL, null)).rejects.toThrow(
    'db-workspace-required'
  )
  await expect(call(DB_PROJECTS_CREATE_MSGPACK_CHANNEL, { name: 'Unscoped' })).rejects.toThrow(
    'db-workspace-required'
  )
  await expect(
    call(DB_SESSIONS_CREATE_MSGPACK_CHANNEL, { id: 'session-a', title: 'Unscoped', mode: 'chat' })
  ).rejects.toThrow('db-workspace-required')
  await expect(call(DB_SESSIONS_DELETE_MSGPACK_CHANNEL, 'session-a')).rejects.toThrow(
    'db-workspace-required'
  )
  await expect(call(DB_SESSIONS_CLEAR_ALL_MSGPACK_CHANNEL, {})).rejects.toThrow(
    'db-workspace-required'
  )
  expect(state.ensureDefaultProject).not.toHaveBeenCalled()
  expect(state.createProject).not.toHaveBeenCalled()
  expect(state.createSession).not.toHaveBeenCalled()
  expect(state.deleteSession).not.toHaveBeenCalled()
  expect(state.clearAllSessions).not.toHaveBeenCalled()
})

it('blocks writes to a team absent from the offline directory', async () => {
  state.available = new Set()
  await expect(
    call(DB_PROJECTS_CREATE_MSGPACK_CHANNEL, { name: 'Denied', workspaceId: 'team-a' })
  ).rejects.toThrow('db-workspace-unavailable')
  await expect(
    call(DB_SESSIONS_CREATE_MSGPACK_CHANNEL, {
      id: 'session-a',
      title: 'Denied',
      mode: 'chat',
      workspaceId: 'team-a'
    })
  ).rejects.toThrow('db-workspace-unavailable')
  expect(state.createProject).not.toHaveBeenCalled()
  expect(state.createSession).not.toHaveBeenCalled()
})

it('requires workspace ownership before plan and task creation', async () => {
  state.getSession.mockResolvedValue(null)
  await expect(
    call(DB_PLANS_CREATE_MSGPACK_CHANNEL, { id: 'plan-a', sessionId: 'session-a', title: 'Plan' })
  ).rejects.toThrow('db-workspace-required')
  await expect(
    call(DB_TASKS_CREATE_MSGPACK_CHANNEL, { id: 'task-a', sessionId: 'session-a', subject: 'Task' })
  ).rejects.toThrow('db-workspace-required')
  await expect(
    call(DB_PLANS_CREATE_MSGPACK_CHANNEL, {
      id: 'plan-a',
      sessionId: 'session-a',
      workspaceId: 'team-a',
      title: 'Plan'
    })
  ).rejects.toThrow('session-workspace-mismatch')
  await expect(
    call(DB_TASKS_CREATE_MSGPACK_CHANNEL, {
      id: 'task-a',
      sessionId: 'session-a',
      workspaceId: 'team-a',
      subject: 'Task'
    })
  ).rejects.toThrow('session-workspace-mismatch')
  expect(state.createPlan).not.toHaveBeenCalled()
  expect(state.createTask).not.toHaveBeenCalled()
})
