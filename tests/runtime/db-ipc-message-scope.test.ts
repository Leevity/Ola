import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, bytes: Uint8Array) => Promise<unknown>>(),
  available: new Set(['team-a']),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  clearAllSessions: vi.fn(),
  getMessages: vi.fn(),
  listProjects: vi.fn(),
  getProject: vi.fn(),
  createProject: vi.fn(),
  ensureDefaultProject: vi.fn(),
  listPlans: vi.fn(),
  createPlan: vi.fn(),
  listAllTasks: vi.fn(),
  createTask: vi.fn(),
  listGoals: vi.fn(),
  getGoal: vi.fn(),
  createGoal: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (_event: unknown, bytes: Uint8Array) => Promise<unknown>) =>
      state.handlers.set(channel, handler)
  }
}))
vi.mock('../../src/main/db/database', () => ({ initializeDatabase: async () => undefined }))
vi.mock('../../src/main/remote/account-client', () => ({
  loadOfflineWorkspaceIds: async () => state.available
}))
vi.mock('../../src/main/db/sessions-dao', () => ({
  getSession: state.getSession,
  listSessions: state.listSessions,
  createSession: state.createSession,
  deleteSession: state.deleteSession,
  clearAllSessions: state.clearAllSessions
}))
vi.mock('../../src/main/db/messages-dao', () => ({ getMessages: state.getMessages }))
vi.mock('../../src/main/db/projects-dao', () => ({
  listProjects: state.listProjects,
  getProject: state.getProject,
  createProject: state.createProject,
  ensureDefaultProject: state.ensureDefaultProject
}))
vi.mock('../../src/main/db/plans-dao', () => ({
  listPlans: state.listPlans,
  createPlan: state.createPlan
}))
vi.mock('../../src/main/db/tasks-dao', () => ({
  listAllTasks: state.listAllTasks,
  createTask: state.createTask
}))
vi.mock('../../src/main/db/goals-dao', () => ({
  listGoals: state.listGoals,
  getGoal: state.getGoal,
  createGoal: state.createGoal
}))

import { registerDbHandlers } from '../../src/main/ipc/db-handlers'
import {
  DB_MESSAGES_LIST_MSGPACK_CHANNEL,
  DB_GOALS_LIST_MSGPACK_CHANNEL,
  DB_GOALS_GET_MSGPACK_CHANNEL,
  DB_GOALS_CREATE_MSGPACK_CHANNEL,
  DB_PLANS_LIST_MSGPACK_CHANNEL,
  DB_PLANS_CREATE_MSGPACK_CHANNEL,
  DB_PROJECTS_GET_MSGPACK_CHANNEL,
  DB_PROJECTS_CREATE_MSGPACK_CHANNEL,
  DB_PROJECTS_ENSURE_DEFAULT_MSGPACK_CHANNEL,
  DB_PROJECTS_LIST_MSGPACK_CHANNEL,
  DB_SESSIONS_GET_MSGPACK_CHANNEL,
  DB_SESSIONS_CREATE_MSGPACK_CHANNEL,
  DB_SESSIONS_DELETE_MSGPACK_CHANNEL,
  DB_SESSIONS_CLEAR_ALL_MSGPACK_CHANNEL,
  DB_SESSIONS_LIST_MSGPACK_CHANNEL,
  DB_TASKS_LIST_ALL_MSGPACK_CHANNEL,
  DB_TASKS_CREATE_MSGPACK_CHANNEL,
  encodeMessagePackPayload,
  decodeMessagePackPayload
} from '../../src/shared/messagepack/binary-ipc'

beforeEach(async () => {
  state.handlers.clear()
  state.available = new Set(['team-a'])
  state.getSession.mockReset()
  state.listSessions.mockReset()
  state.createSession.mockReset()
  state.deleteSession.mockReset()
  state.clearAllSessions.mockReset()
  state.getMessages.mockReset()
  state.listProjects.mockReset()
  state.getProject.mockReset()
  state.createProject.mockReset()
  state.ensureDefaultProject.mockReset()
  state.listPlans.mockReset()
  state.createPlan.mockReset()
  state.listAllTasks.mockReset()
  state.createTask.mockReset()
  state.listGoals.mockReset()
  state.getGoal.mockReset()
  state.createGoal.mockReset()
  await registerDbHandlers()
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
