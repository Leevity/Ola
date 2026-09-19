import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const request = vi.hoisted(() => vi.fn())
vi.mock('../../src/main/lib/native-worker', () => ({
  getNativeWorker: () => ({ request })
}))

import { getSession, listSessions } from '../../src/main/db/sessions-dao'
import {
  createProject,
  findProjectByPluginId,
  getProject,
  listProjects
} from '../../src/main/db/projects-dao'
import { getPlan, getPlanBySession, listPlans } from '../../src/main/db/plans-dao'
import { getTask, listAllTasks, listTasksBySession } from '../../src/main/db/tasks-dao'
import {
  getMessageCount,
  getMessages,
  getMessagesRequestContext,
  getMessagesWindowAround,
  searchMessageContent
} from '../../src/main/db/messages-dao'
import { closeLegacyReadCanary } from '../../src/main/db/legacy-read-canary'

const originalPath = process.env.OLA_TS_LEGACY_READ_PATH
const originalSessionReads = process.env.OLA_TS_SESSION_READS
const originalProjectReads = process.env.OLA_TS_PROJECT_READS
const originalPlanReads = process.env.OLA_TS_PLAN_READS
const originalTaskReads = process.env.OLA_TS_TASK_READS
const originalMessageReads = process.env.OLA_TS_MESSAGE_READS
const originalE2eRoot = process.env.OLA_E2E_DATA_ROOT

afterEach(async () => {
  await closeLegacyReadCanary()
  request.mockReset()
  if (originalPath === undefined) delete process.env.OLA_TS_LEGACY_READ_PATH
  else process.env.OLA_TS_LEGACY_READ_PATH = originalPath
  if (originalSessionReads === undefined) delete process.env.OLA_TS_SESSION_READS
  else process.env.OLA_TS_SESSION_READS = originalSessionReads
  if (originalProjectReads === undefined) delete process.env.OLA_TS_PROJECT_READS
  else process.env.OLA_TS_PROJECT_READS = originalProjectReads
  if (originalPlanReads === undefined) delete process.env.OLA_TS_PLAN_READS
  else process.env.OLA_TS_PLAN_READS = originalPlanReads
  if (originalTaskReads === undefined) delete process.env.OLA_TS_TASK_READS
  else process.env.OLA_TS_TASK_READS = originalTaskReads
  if (originalMessageReads === undefined) delete process.env.OLA_TS_MESSAGE_READS
  else process.env.OLA_TS_MESSAGE_READS = originalMessageReads
  if (originalE2eRoot === undefined) delete process.env.OLA_E2E_DATA_ROOT
  else process.env.OLA_E2E_DATA_ROOT = originalE2eRoot
})

it('routes Main-created projects to the marked E2E root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-project-e2e-root-'))
  try {
    await writeFile(join(directory, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
    process.env.OLA_E2E_DATA_ROOT = directory
    request.mockResolvedValue({ id: 'project-e2e' })
    await createProject({ name: 'Test project', workspaceId: 'local-personal' })
    expect(request).toHaveBeenCalledWith(
      'db/projects-create',
      expect.objectContaining({ baseDirectory: join(directory, 'projects') }),
      120_000
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('falls back to Native project reads when the default TS reader cannot open its database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-project-read-fallback-'))
  try {
    process.env.OLA_TS_LEGACY_READ_PATH = join(directory, 'missing.db')
    delete process.env.OLA_TS_PROJECT_READS
    request.mockImplementation(async (method: string) =>
      method === 'db/projects-list'
        ? [{ id: 'project-a', workspace_id: 'team-a' }]
        : { success: true, project: { id: 'project-a', workspace_id: 'team-a' } }
    )
    await expect(listProjects('team-a')).resolves.toMatchObject([{ id: 'project-a' }])
    await expect(getProject('project-a', 'team-a')).resolves.toMatchObject({ id: 'project-a' })
    await expect(findProjectByPluginId('plugin-a', 'team-a')).resolves.toMatchObject({
      id: 'project-a'
    })
    expect(request).toHaveBeenCalledWith('db/projects-list', { workspaceId: 'team-a' }, 120_000)
    expect(request).toHaveBeenCalledWith(
      'db/projects-get',
      { id: 'project-a', workspaceId: 'team-a' },
      120_000
    )
    expect(request).toHaveBeenCalledWith(
      'db/projects-find-by-plugin',
      { pluginId: 'plugin-a', workspaceId: 'team-a' },
      120_000
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('falls back to Native plan reads when the default TS reader cannot open its database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-plan-read-fallback-'))
  try {
    process.env.OLA_TS_LEGACY_READ_PATH = join(directory, 'missing.db')
    delete process.env.OLA_TS_PLAN_READS
    request.mockImplementation(async (method: string) =>
      method === 'db/plans-list'
        ? [{ id: 'plan-a', workspace_id: 'team-a' }]
        : { success: true, plan: { id: 'plan-a', workspace_id: 'team-a' } }
    )
    await expect(listPlans('team-a')).resolves.toMatchObject([{ id: 'plan-a' }])
    await expect(getPlan('plan-a', 'team-a')).resolves.toMatchObject({ id: 'plan-a' })
    await expect(getPlanBySession('session-a', 'team-a')).resolves.toMatchObject({ id: 'plan-a' })
    expect(request).toHaveBeenCalledWith('db/plans-list', { workspaceId: 'team-a' }, 120_000)
    expect(request).toHaveBeenCalledWith(
      'db/plans-get',
      { id: 'plan-a', workspaceId: 'team-a' },
      120_000
    )
    expect(request).toHaveBeenCalledWith(
      'db/plans-get-by-session',
      { sessionId: 'session-a', workspaceId: 'team-a' },
      120_000
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('falls back to Native task reads when the default TS reader cannot open its database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-task-read-fallback-'))
  try {
    process.env.OLA_TS_LEGACY_READ_PATH = join(directory, 'missing.db')
    delete process.env.OLA_TS_TASK_READS
    request.mockImplementation(async (method: string) =>
      method === 'db/tasks-get'
        ? { success: true, task: { id: 'task-a', session_id: 'session-a' } }
        : [{ id: 'task-a', session_id: 'session-a' }]
    )
    await expect(listAllTasks('team-a')).resolves.toMatchObject([{ id: 'task-a' }])
    await expect(listTasksBySession('session-a', 'team-a')).resolves.toMatchObject([
      { id: 'task-a' }
    ])
    await expect(getTask('task-a', 'team-a')).resolves.toMatchObject({ id: 'task-a' })
    expect(request).toHaveBeenCalledWith('db/tasks-list-all', { workspaceId: 'team-a' }, 120_000)
    expect(request).toHaveBeenCalledWith(
      'db/tasks-list-by-session',
      { sessionId: 'session-a', workspaceId: 'team-a' },
      120_000
    )
    expect(request).toHaveBeenCalledWith(
      'db/tasks-get',
      { id: 'task-a', workspaceId: 'team-a' },
      120_000
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('falls back to Native message reads when the default TS reader cannot open its database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-message-read-fallback-'))
  try {
    process.env.OLA_TS_LEGACY_READ_PATH = join(directory, 'missing.db')
    delete process.env.OLA_TS_MESSAGE_READS
    request.mockImplementation(async (method: string) => {
      if (method === 'db/messages-count') return { success: true, count: 1 }
      if (method === 'db/messages-search-content')
        return [{ session_id: 'session-a', snippet: 'message' }]
      if (method === 'db/messages-window-around')
        return { success: true, rows: [], start: 0, end: 0, total: 0, anchorSortOrder: 0 }
      return [{ id: 'message-a', session_id: 'session-a' }]
    })
    await expect(getMessages('session-a', 'team-a')).resolves.toMatchObject([{ id: 'message-a' }])
    await expect(getMessageCount('session-a', 'team-a')).resolves.toBe(1)
    await expect(
      getMessagesRequestContext({ sessionId: 'session-a', workspaceId: 'team-a', maxMessages: 10 })
    ).resolves.toMatchObject([{ id: 'message-a' }])
    await expect(
      getMessagesWindowAround({ sessionId: 'session-a', workspaceId: 'team-a', limit: 5 })
    ).resolves.toMatchObject({ success: true, total: 0 })
    await expect(searchMessageContent('message', 1, 'team-a')).resolves.toEqual([
      { session_id: 'session-a', snippet: 'message' }
    ])
    expect(request).toHaveBeenCalledWith('db/messages-list', { sessionId: 'session-a' }, 120_000)
    expect(request).toHaveBeenCalledWith('db/messages-count', { sessionId: 'session-a' }, 120_000)
    expect(request).toHaveBeenCalledWith(
      'db/messages-search-content',
      { query: 'message', limit: 1, workspaceId: 'team-a' },
      120_000
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('falls back to Native session reads when the default TS reader cannot open its database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-session-read-fallback-'))
  try {
    process.env.OLA_TS_LEGACY_READ_PATH = join(directory, 'missing.db')
    delete process.env.OLA_TS_SESSION_READS
    request.mockImplementation(async (method: string) =>
      method === 'db/sessions-list'
        ? [{ id: 'session-a', workspace_id: 'team-a' }]
        : { success: true, session: { id: 'session-a', workspace_id: 'team-a' } }
    )
    await expect(listSessions(10, 0, 'team-a')).resolves.toMatchObject([{ id: 'session-a' }])
    await expect(getSession('session-a', 'team-a')).resolves.toMatchObject({ id: 'session-a' })
    expect(request).toHaveBeenCalledWith(
      'db/sessions-list',
      { limit: 10, offset: 0, workspaceId: 'team-a' },
      120_000
    )
    expect(request).toHaveBeenCalledWith(
      'db/sessions-get',
      { id: 'session-a', workspaceId: 'team-a' },
      120_000
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
