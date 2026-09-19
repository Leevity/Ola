import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canaryGetSession,
  canaryFindProjectByPlugin,
  canaryGetProject,
  canaryListPluginSessions,
  canaryListAllPluginSessions,
  canaryFindPluginSessionByChat,
  canaryListPluginSessionMessages,
  canaryChannelSessionStatus,
  canaryChannelSessionUsageStats,
  canaryGetTask,
  canaryGetPlan,
  canaryGetPlanBySession,
  canaryGetGoal,
  canaryListGoals,
  canaryListGoalEvents,
  canaryListUsageEvents,
  canaryGetUsageOverview,
  canaryGetRawUsageRows,
  canaryGetUsageActivity,
  canaryResolveQqWakeupEligibility,
  canaryListProjects,
  canaryListTasks,
  canaryListTasksBySession,
  canaryListPlans,
  canaryListMessageLocatorRows,
  canaryListMessageMarkers,
  canaryListSessions,
  canaryListMessages,
  canaryListMessagesPage,
  canaryListUserMessages,
  canaryGetMessageCount,
  canaryGetMessagesRequestContext,
  canaryGetMessagesWindowAround,
  canarySearchMessageContent,
  canaryGetAgentChangeSet,
  canaryListAgentChangeSetsBySession,
  closeLegacyReadCanary
} from '../../src/main/db/legacy-read-canary'

const cleanup: string[] = []
const originalEnabled = process.env.OLA_TS_LEGACY_READS
const originalSessionReads = process.env.OLA_TS_SESSION_READS
const originalProjectReads = process.env.OLA_TS_PROJECT_READS
const originalPlanReads = process.env.OLA_TS_PLAN_READS
const originalTaskReads = process.env.OLA_TS_TASK_READS
const originalMessageReads = process.env.OLA_TS_MESSAGE_READS
const originalGoalReads = process.env.OLA_TS_GOAL_READS
const originalUsageEventReads = process.env.OLA_TS_USAGE_EVENT_READS
const originalUsageAnalyticsReads = process.env.OLA_TS_USAGE_ANALYTICS_READS
const originalChannelSessionReads = process.env.OLA_TS_CHANNEL_SESSION_READS
const originalAgentChangeReads = process.env.OLA_TS_AGENT_CHANGE_READS
const originalQqWakeupReads = process.env.OLA_TS_QQ_WAKEUP_READS
const originalPath = process.env.OLA_TS_LEGACY_READ_PATH

afterEach(async () => {
  await closeLegacyReadCanary()
  if (originalEnabled === undefined) delete process.env.OLA_TS_LEGACY_READS
  else process.env.OLA_TS_LEGACY_READS = originalEnabled
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
  if (originalGoalReads === undefined) delete process.env.OLA_TS_GOAL_READS
  else process.env.OLA_TS_GOAL_READS = originalGoalReads
  if (originalUsageEventReads === undefined) delete process.env.OLA_TS_USAGE_EVENT_READS
  else process.env.OLA_TS_USAGE_EVENT_READS = originalUsageEventReads
  if (originalUsageAnalyticsReads === undefined) delete process.env.OLA_TS_USAGE_ANALYTICS_READS
  else process.env.OLA_TS_USAGE_ANALYTICS_READS = originalUsageAnalyticsReads
  if (originalChannelSessionReads === undefined) delete process.env.OLA_TS_CHANNEL_SESSION_READS
  else process.env.OLA_TS_CHANNEL_SESSION_READS = originalChannelSessionReads
  if (originalAgentChangeReads === undefined) delete process.env.OLA_TS_AGENT_CHANGE_READS
  else process.env.OLA_TS_AGENT_CHANGE_READS = originalAgentChangeReads
  if (originalQqWakeupReads === undefined) delete process.env.OLA_TS_QQ_WAKEUP_READS
  else process.env.OLA_TS_QQ_WAKEUP_READS = originalQqWakeupReads
  if (originalPath === undefined) delete process.env.OLA_TS_LEGACY_READ_PATH
  else process.env.OLA_TS_LEGACY_READ_PATH = originalPath
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ola-legacy-canary-'))
  cleanup.push(directory)
  const path = join(directory, 'data.db')
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, icon TEXT, mode TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, project_id TEXT,
      working_folder TEXT, ssh_connection_id TEXT, plan_id TEXT, pinned INTEGER NOT NULL,
      plugin_id TEXT, external_chat_id TEXT, provider_id TEXT, model_id TEXT, model_selection_mode TEXT,
      model_source TEXT, workspace_id TEXT NOT NULL, message_count INTEGER NOT NULL,
      task_profile TEXT, task_profile_locked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, working_folder TEXT, ssh_connection_id TEXT,
      plugin_id TEXT, pinned INTEGER NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, workspace_id TEXT NOT NULL, model_source TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, plan_id TEXT, subject TEXT NOT NULL,
      description TEXT NOT NULL, active_form TEXT, status TEXT NOT NULL, owner TEXT,
      blocks TEXT NOT NULL, blocked_by TEXT NOT NULL, metadata TEXT, sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE plans (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      file_path TEXT, content TEXT, spec_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
      meta TEXT, created_at INTEGER NOT NULL, usage TEXT, sort_order INTEGER NOT NULL
    );
    CREATE TABLE session_goals (
      session_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, objective TEXT NOT NULL,
      status TEXT NOT NULL, token_budget INTEGER, tokens_used INTEGER NOT NULL,
      time_used_seconds INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE session_goal_events (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, goal_id TEXT,
      event_type TEXT NOT NULL, message TEXT, metadata_json TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE agent_change_sets (
      run_id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT NOT NULL,
      assistant_message_id TEXT NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_file_changes (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, session_id TEXT,
      tool_use_id TEXT, tool_name TEXT, file_path TEXT NOT NULL,
      transport TEXT NOT NULL, connection_id TEXT, op TEXT NOT NULL,
      status TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, reverted_at INTEGER, sort_order INTEGER NOT NULL
    );
  `)
  const insert = db.prepare(
    `INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  for (const [id, workspaceId] of [
    ['session-a', 'team-a'],
    ['session-b', 'team-b']
  ]) {
    insert.run(
      id,
      id,
      null,
      'chat',
      1,
      1,
      null,
      null,
      null,
      null,
      0,
      workspaceId === 'team-a' ? 'plugin-a' : 'plugin-b',
      workspaceId === 'team-a' ? 'chat-a' : 'chat-b',
      null,
      null,
      'inherit',
      null,
      workspaceId,
      0,
      'chat',
      0
    )
  }
  db.prepare(`INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    'project-a',
    'A project',
    null,
    null,
    'plugin-a',
    0,
    1,
    1,
    'team-a',
    null
  )
  db.prepare(`INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    'project-b',
    'B project',
    null,
    null,
    'plugin-b',
    0,
    1,
    1,
    'team-b',
    null
  )
  db.prepare(`INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'task-a',
    'session-a',
    null,
    'A task',
    '',
    null,
    'pending',
    null,
    '[]',
    '[]',
    null,
    0,
    1,
    1
  )
  db.prepare(`INSERT INTO plans VALUES(?,?,?,?,?,?,?,?,?)`).run(
    'plan-a',
    'session-a',
    'A plan',
    'drafting',
    null,
    'content',
    null,
    1,
    1
  )
  db.prepare(`INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)`).run(
    'message-a',
    'session-a',
    'user',
    'A message',
    null,
    1,
    null,
    0
  )
  db.prepare(`INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)`).run(
    'message-a-assistant',
    'session-a',
    'assistant',
    'A answer',
    null,
    2,
    null,
    1
  )
  db.prepare(`INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)`).run(
    'message-b',
    'session-b',
    'user',
    'B message',
    null,
    1,
    null,
    0
  )
  db.prepare(`INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'task-b',
    'session-b',
    null,
    'B task',
    '',
    null,
    'pending',
    null,
    '[]',
    '[]',
    null,
    0,
    1,
    1
  )
  db.prepare(`INSERT INTO plans VALUES(?,?,?,?,?,?,?,?,?)`).run(
    'plan-b',
    'session-b',
    'B plan',
    'drafting',
    null,
    'hidden',
    null,
    1,
    1
  )
  db.exec(`
    INSERT INTO session_goals VALUES
      ('session-a','goal-a','Team objective','active',100,2,3,1,2),
      ('session-b','goal-b','Other objective','active',NULL,0,0,1,1);
    INSERT INTO session_goal_events VALUES
      ('event-a','session-a','goal-a','created','Team event',NULL,1),
      ('event-b','session-b','goal-b','created','Other event',NULL,1);
    INSERT INTO agent_change_sets VALUES
      ('run-a','session-a','team-a','assistant-a','open',1,1),
      ('run-b','session-b','team-b','assistant-b','open',2,2);
    INSERT INTO agent_file_changes
      (id,run_id,session_id,file_path,transport,op,status,before_json,after_json,created_at,sort_order)
    VALUES
      ('change-a','run-a','session-a','/tmp/a.txt','local','create','open',
       '{"exists":false,"hash":null,"size":0}',
       '{"exists":true,"text":"A","hash":null,"size":1}',1,0),
      ('change-b','run-b','session-b','/tmp/b.txt','local','create','open',
       '{"exists":false,"hash":null,"size":0}',
       '{"exists":true,"text":"B","hash":null,"size":1}',2,0);
  `)
  db.close()
  return path
}

describe('legacy read canary', () => {
  it('uses workspace-scoped Goal reads by default and supports a fallback switch', async () => {
    process.env.OLA_TS_LEGACY_READ_PATH = await fixture()
    delete process.env.OLA_TS_GOAL_READS
    await expect(canaryListGoals('team-a')).resolves.toMatchObject([
      { session_id: 'session-a', objective: 'Team objective' }
    ])
    await expect(canaryGetGoal('session-a', 'team-a')).resolves.toMatchObject({
      goal_id: 'goal-a'
    })
    await expect(canaryGetGoal('session-b', 'team-a')).resolves.toBeNull()
    await expect(
      canaryListGoalEvents({ sessionId: 'session-a', workspaceId: 'team-a' })
    ).resolves.toMatchObject([{ id: 'event-a' }])
    await expect(
      canaryListGoalEvents({ sessionId: 'session-b', workspaceId: 'team-a' })
    ).resolves.toEqual([])
    await expect(canaryListGoals('team-b')).resolves.toMatchObject([{ session_id: 'session-b' }])
    process.env.OLA_TS_GOAL_READS = '0'
    await expect(canaryListGoals('team-a')).resolves.toBeUndefined()
    await expect(canaryGetGoal('session-a', 'team-a')).resolves.toBeUndefined()
    await expect(
      canaryListGoalEvents({ sessionId: 'session-a', workspaceId: 'team-a' })
    ).resolves.toBeUndefined()
  })

  it('falls back for malformed message order and resumes TS reads after Native repair', async () => {
    const path = await fixture()
    process.env.OLA_TS_LEGACY_READ_PATH = path
    process.env.OLA_TS_LEGACY_READS = '1'
    const db = new DatabaseSync(path)
    db.prepare('UPDATE messages SET sort_order = 7 WHERE id = ?').run('message-a')
    await expect(canaryListMessages('session-a', 'team-a')).resolves.toBeUndefined()
    db.prepare('UPDATE messages SET sort_order = 0 WHERE id = ?').run('message-a')
    db.close()
    await expect(canaryListMessages('session-a', 'team-a')).resolves.toMatchObject([
      { id: 'message-a' },
      { id: 'message-a-assistant' }
    ])
  })

  it('uses scoped TS core reads by default while leaving other canaries opt-in', async () => {
    const fixturePath = await fixture()
    process.env.OLA_TS_LEGACY_READ_PATH = fixturePath
    const usageDb = new DatabaseSync(fixturePath)
    usageDb
      .prepare('UPDATE messages SET usage=? WHERE id=?')
      .run('{"inputTokens":8,"outputTokens":3}', 'message-a-assistant')
    usageDb.close()
    delete process.env.OLA_TS_LEGACY_READS
    delete process.env.OLA_TS_SESSION_READS
    delete process.env.OLA_TS_PROJECT_READS
    delete process.env.OLA_TS_PLAN_READS
    delete process.env.OLA_TS_TASK_READS
    delete process.env.OLA_TS_MESSAGE_READS
    delete process.env.OLA_TS_CHANNEL_SESSION_READS
    delete process.env.OLA_TS_AGENT_CHANGE_READS
    await expect(
      canaryListSessions({ workspaceId: 'team-a', limit: 1, offset: 0 })
    ).resolves.toMatchObject([{ id: 'session-a' }])
    await expect(
      canaryGetSession({ id: 'session-a', workspaceId: 'team-a' })
    ).resolves.toMatchObject({ id: 'session-a' })
    await expect(canaryListProjects('team-a')).resolves.toMatchObject([{ id: 'project-a' }])
    await expect(canaryListPlans('team-a')).resolves.toMatchObject([{ id: 'plan-a' }])
    await expect(canaryListTasks('team-a')).resolves.toMatchObject([{ id: 'task-a' }])
    await expect(canaryListMessages('session-a', 'team-a')).resolves.toMatchObject([
      { id: 'message-a' },
      { id: 'message-a-assistant' }
    ])
    await expect(canaryGetMessageCount('session-a', 'team-a')).resolves.toBe(0)
    await expect(canarySearchMessageContent('A message', 'team-a', 1)).resolves.toEqual([
      { session_id: 'session-a', snippet: 'A message' }
    ])
    await expect(canaryListPluginSessions('plugin-a', 'team-a')).resolves.toMatchObject([
      { id: 'session-a' }
    ])
    await expect(canaryListAllPluginSessions('team-a')).resolves.toMatchObject([
      { id: 'session-a' }
    ])
    await expect(canaryFindPluginSessionByChat('chat-a', 'team-a')).resolves.toMatchObject({
      id: 'session-a'
    })
    await expect(canaryListPluginSessionMessages('session-a', 'team-a')).resolves.toMatchObject([
      { id: 'message-a' },
      { id: 'message-a-assistant' }
    ])
    await expect(canaryChannelSessionStatus('session-a', 'team-a')).resolves.toMatchObject({
      found: true,
      messageCount: 2
    })
    await expect(canaryChannelSessionStatus('session-a', 'team-b')).resolves.toMatchObject({
      found: false,
      messageCount: 0
    })
    await expect(canaryChannelSessionUsageStats('session-a', 'team-a')).resolves.toMatchObject({
      hasUsage: true,
      totalInput: 8,
      totalOutput: 3,
      assistantReplies: 1
    })
    await expect(canaryChannelSessionUsageStats('session-a', 'team-b')).resolves.toMatchObject({
      hasUsage: false,
      totalInput: 0
    })
    await expect(canaryGetAgentChangeSet('run-a', 'team-a')).resolves.toMatchObject({
      runId: 'run-a'
    })
    await expect(canaryListAgentChangeSetsBySession('session-a', 'team-a')).resolves.toMatchObject([
      { runId: 'run-a' }
    ])
    process.env.OLA_TS_SESSION_READS = '0'
    process.env.OLA_TS_PROJECT_READS = '0'
    process.env.OLA_TS_PLAN_READS = '0'
    process.env.OLA_TS_TASK_READS = '0'
    process.env.OLA_TS_MESSAGE_READS = '0'
    process.env.OLA_TS_CHANNEL_SESSION_READS = '0'
    process.env.OLA_TS_AGENT_CHANGE_READS = '0'
    await expect(canaryListSessions({ workspaceId: 'team-a', limit: 1, offset: 0 })).resolves.toBe(
      null
    )
    await expect(canaryListProjects('team-a')).resolves.toBeUndefined()
    await expect(canaryListPlans('team-a')).resolves.toBeUndefined()
    await expect(canaryListTasks('team-a')).resolves.toBeUndefined()
    await expect(canaryListMessages('session-a', 'team-a')).resolves.toBeUndefined()
    await expect(canarySearchMessageContent('A message', 'team-a', 1)).resolves.toBeUndefined()
    await expect(canaryListPluginSessions('plugin-a', 'team-a')).resolves.toBeUndefined()
    await expect(canaryListAllPluginSessions('team-a')).resolves.toBeUndefined()
    await expect(canaryFindPluginSessionByChat('chat-a', 'team-a')).resolves.toBeUndefined()
    await expect(canaryListPluginSessionMessages('session-a', 'team-a')).resolves.toBeUndefined()
    await expect(canaryChannelSessionStatus('session-a', 'team-a')).resolves.toBeUndefined()
    await expect(canaryChannelSessionUsageStats('session-a', 'team-a')).resolves.toBeUndefined()
    await expect(canaryGetAgentChangeSet('run-a', 'team-a')).resolves.toBeUndefined()
    await expect(canaryListAgentChangeSetsBySession('session-a', 'team-a')).resolves.toBeUndefined()
  })

  it('falls back cleanly when the default usage list encounters an older schema', async () => {
    process.env.OLA_TS_LEGACY_READ_PATH = await fixture()
    delete process.env.OLA_TS_LEGACY_READS
    delete process.env.OLA_TS_USAGE_EVENT_READS
    delete process.env.OLA_TS_USAGE_ANALYTICS_READS
    delete process.env.OLA_TS_QQ_WAKEUP_READS
    await expect(
      canaryListUsageEvents({ workspaceId: 'team-a', from: 0, to: 1_000 })
    ).resolves.toBeUndefined()
    await expect(
      canaryGetUsageOverview({ workspaceId: 'team-a', from: 0, to: 1_000 })
    ).resolves.toBeUndefined()
    await expect(
      canaryGetRawUsageRows('daily', { workspaceId: 'team-a', from: 0, to: 1_000 })
    ).resolves.toBeUndefined()
    await expect(
      canaryGetUsageActivity('activity-overview', {
        workspaceId: 'team-a',
        from: 0,
        to: 1_000
      })
    ).resolves.toBeUndefined()
    await expect(
      canaryResolveQqWakeupEligibility({
        workspaceId: 'team-a',
        pluginId: 'plugin-a',
        openId: 'open-a',
        now: 1_000
      })
    ).resolves.toBeUndefined()
    await expect(
      canaryListSessions({ workspaceId: 'team-a', limit: 1, offset: 0 })
    ).resolves.toMatchObject([{ id: 'session-a' }])
  })

  it('reads only an explicit workspace when the Main-process canary is enabled', async () => {
    process.env.OLA_TS_LEGACY_READ_PATH = await fixture()
    process.env.OLA_TS_LEGACY_READS = '1'
    await expect(
      canaryListSessions({ workspaceId: 'team-a', limit: 10, offset: 0 })
    ).resolves.toMatchObject([{ id: 'session-a', workspace_id: 'team-a' }])
    await expect(canaryGetSession({ id: 'session-b', workspaceId: 'team-a' })).resolves.toBeNull()
    await expect(canaryListProjects('team-a')).resolves.toMatchObject([{ id: 'project-a' }])
    await expect(canaryGetProject('project-a', 'team-a')).resolves.toMatchObject({
      id: 'project-a',
      workspace_id: 'team-a'
    })
    await expect(canaryGetProject('project-b', 'team-a')).resolves.toBeNull()
    await expect(canaryFindProjectByPlugin('plugin-a', 'team-a')).resolves.toMatchObject({
      id: 'project-a',
      workspace_id: 'team-a'
    })
    await expect(canaryFindProjectByPlugin('plugin-b', 'team-a')).resolves.toBeNull()
    await expect(canaryListPluginSessions('plugin-a', 'team-a')).resolves.toMatchObject([
      { id: 'session-a', external_chat_id: 'chat-a', workspace_id: 'team-a' }
    ])
    await expect(canaryListPluginSessions('plugin-b', 'team-a')).resolves.toEqual([])
    await expect(canaryListAllPluginSessions('team-a')).resolves.toMatchObject([
      { id: 'session-a' }
    ])
    await expect(canaryFindPluginSessionByChat('chat-a', 'team-a')).resolves.toMatchObject({
      id: 'session-a'
    })
    await expect(canaryFindPluginSessionByChat('chat-b', 'team-a')).resolves.toBeNull()
    await expect(canaryListPluginSessionMessages('session-a', 'team-a')).resolves.toMatchObject([
      { id: 'message-a' },
      { id: 'message-a-assistant' }
    ])
    await expect(canaryListPluginSessionMessages('session-b', 'team-a')).resolves.toEqual([])
    await expect(canaryListTasks('team-a')).resolves.toMatchObject([{ id: 'task-a' }])
    await expect(canaryListTasksBySession('session-a', 'team-a')).resolves.toMatchObject([
      { id: 'task-a' }
    ])
    await expect(canaryGetTask('task-b', 'team-a')).resolves.toBeNull()
    await expect(canaryListPlans('team-a')).resolves.toMatchObject([{ id: 'plan-a' }])
    await expect(canaryGetPlan('plan-b', 'team-a')).resolves.toBeNull()
    await expect(canaryGetPlanBySession('session-a', 'team-a')).resolves.toMatchObject({
      id: 'plan-a'
    })
    await expect(canaryGetPlanBySession('session-b', 'team-a')).resolves.toBeNull()
    await expect(canaryListMessages('session-a', 'team-a')).resolves.toMatchObject([
      { id: 'message-a' },
      { id: 'message-a-assistant' }
    ])
    await expect(canaryListMessages('session-b', 'team-a')).resolves.toEqual([])
    await expect(canaryListUserMessages('session-a', 'team-a')).resolves.toMatchObject([
      { id: 'message-a', role: 'user' }
    ])
    await expect(canaryListUserMessages('session-b', 'team-a')).resolves.toEqual([])
    await expect(canaryListMessageLocatorRows('session-a', 'team-a')).resolves.toMatchObject([
      { id: 'message-a' },
      { id: 'message-a-assistant' }
    ])
    await expect(canaryListMessageLocatorRows('session-b', 'team-a')).resolves.toEqual([])
    await expect(canaryListMessagesPage('session-a', 'team-a', 1, 1)).resolves.toMatchObject([
      { id: 'message-a-assistant' }
    ])
    await expect(canaryListMessagesPage('session-b', 'team-a', 1, 0)).resolves.toEqual([])
    await expect(canaryListMessageMarkers('session-a', 'team-a')).resolves.toMatchObject([
      { id: 'message-a' },
      { id: 'message-a-assistant' }
    ])
    await expect(canaryListMessageMarkers('session-b', 'team-a')).resolves.toEqual([])
    await expect(canaryGetMessageCount('session-a', 'team-a')).resolves.toBe(0)
    await expect(canaryGetMessageCount('session-b', 'team-a')).resolves.toBe(0)
    await expect(
      canaryGetMessagesRequestContext({
        sessionId: 'session-a',
        workspaceId: 'team-a',
        maxMessages: 1
      })
    ).resolves.toMatchObject([{ id: 'message-a-assistant' }])
    await expect(
      canaryGetMessagesWindowAround({
        sessionId: 'session-a',
        workspaceId: 'team-a',
        messageId: 'message-a',
        limit: 1
      })
    ).resolves.toMatchObject({
      success: true,
      rows: [{ id: 'message-a' }],
      total: 2,
      anchorSortOrder: 0
    })
    await expect(
      canaryGetMessagesWindowAround({
        sessionId: 'session-b',
        workspaceId: 'team-a',
        limit: 30
      })
    ).resolves.toMatchObject({ success: true, rows: [], total: 0 })
    await expect(canarySearchMessageContent('answer', 'team-a')).resolves.toEqual([
      { session_id: 'session-a', snippet: 'A answer' }
    ])
    await expect(canarySearchMessageContent('hidden', 'team-a')).resolves.toEqual([])
    await expect(canaryGetAgentChangeSet('run-a', 'team-a')).resolves.toMatchObject({
      changes: [{ id: 'change-a', after: { text: 'A' } }]
    })
    await expect(canaryGetAgentChangeSet('run-b', 'team-a')).resolves.toBeNull()
    await expect(canaryListAgentChangeSetsBySession('session-a', 'team-a')).resolves.toMatchObject([
      { runId: 'run-a' }
    ])
    await expect(canaryListAgentChangeSetsBySession('session-b', 'team-a')).resolves.toBeUndefined()
    await expect(canaryListSessions({ limit: 10, offset: 0 })).resolves.toBeNull()
  })
})
