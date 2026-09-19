import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LegacyReadRepository } from '../../src/runtime/storage/legacy-read-repository'

const cleanup: string[] = []
const repositories: LegacyReadRepository[] = []

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.close()))
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ola-legacy-read-'))
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
  `)
  const session = db.prepare(
    `INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  session.run(
    'a-session',
    'A',
    null,
    'chat',
    1,
    10,
    null,
    null,
    null,
    null,
    1,
    'plugin-a',
    'chat-a',
    'local',
    'm',
    'inherit',
    null,
    'team-a',
    2,
    'chat',
    0
  )
  session.run(
    'b-session',
    'B',
    null,
    'chat',
    2,
    20,
    null,
    null,
    null,
    null,
    0,
    'plugin-b',
    'chat-b',
    'local',
    'm',
    'inherit',
    null,
    'team-b',
    3,
    'chat',
    0
  )
  db.prepare(`INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    'a-project',
    'Project A',
    null,
    null,
    null,
    0,
    1,
    2,
    'team-a',
    null
  )
  db.prepare(`INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    'b-project',
    'Project B',
    null,
    null,
    null,
    0,
    1,
    2,
    'team-b',
    null
  )
  db.prepare(`INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'a-task',
    'a-session',
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
    2
  )
  db.prepare(`INSERT INTO plans VALUES(?,?,?,?,?,?,?,?,?)`).run(
    'a-plan',
    'a-session',
    'A plan',
    'drafting',
    null,
    'content',
    null,
    1,
    2
  )
  db.prepare(`INSERT INTO plans VALUES(?,?,?,?,?,?,?,?,?)`).run(
    'b-plan',
    'b-session',
    'B plan',
    'drafting',
    null,
    'hidden',
    null,
    1,
    2
  )
  db.prepare(`INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)`).run(
    'a-message',
    'a-session',
    'user',
    'hello',
    null,
    1,
    null,
    0
  )
  db.prepare(`INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)`).run(
    'a-assistant-message',
    'a-session',
    'assistant',
    'answer',
    null,
    2,
    null,
    1
  )
  db.prepare(`INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)`).run(
    'b-message',
    'b-session',
    'user',
    'hidden',
    null,
    1,
    null,
    0
  )
  db.prepare(`INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'b-task',
    'b-session',
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
    2
  )
  db.close()
  return path
}

describe('legacy read repository', () => {
  it('uses Native project ordering for pinned, regular, and plugin projects', async () => {
    const path = await fixture()
    const db = new DatabaseSync(path)
    const insert = db.prepare(`INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?,?)`)
    insert.run('plugin-newer', 'Plugin newer', null, null, 'plugin-a', 0, 1, 9, 'team-a', null)
    insert.run('regular-older', 'Regular older', null, null, null, 0, 1, 3, 'team-a', null)
    insert.run('plugin-pinned', 'Plugin pinned', null, null, 'plugin-a', 1, 1, 4, 'team-a', null)
    db.close()

    const repository = new LegacyReadRepository(path)
    repositories.push(repository)
    await expect(repository.projects('team-a')).resolves.toMatchObject([
      { id: 'plugin-pinned' },
      { id: 'regular-older' },
      { id: 'a-project' },
      { id: 'plugin-newer' }
    ])
    await expect(repository.projects('team-a', 2, 1)).resolves.toMatchObject([
      { id: 'regular-older' },
      { id: 'a-project' }
    ])
    await expect(repository.projectByPlugin('plugin-a', 'team-a')).resolves.toMatchObject({
      id: 'plugin-pinned'
    })
  })

  it('returns a complete project list beyond the paged-read cap', async () => {
    const path = await fixture()
    const db = new DatabaseSync(path)
    const insert = db.prepare(`INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?,?)`)
    db.exec('BEGIN')
    for (let index = 0; index < 2001; index += 1) {
      insert.run(`bulk-${index}`, `Bulk ${index}`, null, null, null, 0, 1, index, 'team-a', null)
    }
    db.exec('COMMIT')
    db.close()

    const repository = new LegacyReadRepository(path)
    repositories.push(repository)
    expect((await repository.allProjects('team-a')).length).toBe(2002)
    expect((await repository.projects('team-a', 2000)).length).toBe(2000)
  })

  it('returns a complete plan list beyond the paged-read cap', async () => {
    const path = await fixture()
    const db = new DatabaseSync(path)
    const insert = db.prepare(`INSERT INTO plans VALUES(?,?,?,?,?,?,?,?,?)`)
    db.exec('BEGIN')
    for (let index = 0; index < 2001; index += 1) {
      insert.run(
        `bulk-plan-${index}`,
        'a-session',
        `Bulk ${index}`,
        'drafting',
        null,
        null,
        null,
        1,
        index
      )
    }
    db.exec('COMMIT')
    db.close()

    const repository = new LegacyReadRepository(path)
    repositories.push(repository)
    expect((await repository.allPlans('team-a')).length).toBe(2002)
    expect((await repository.plans('team-a', 2000)).length).toBe(2000)
  })

  it('returns complete workspace and session task lists beyond the paged-read cap', async () => {
    const path = await fixture()
    const db = new DatabaseSync(path)
    const insert = db.prepare(`INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    db.exec('BEGIN')
    for (let index = 0; index < 2001; index += 1) {
      insert.run(
        `bulk-task-${index}`,
        'a-session',
        null,
        `Bulk ${index}`,
        '',
        null,
        'pending',
        null,
        '[]',
        '[]',
        null,
        index,
        1,
        index
      )
    }
    db.exec('COMMIT')
    db.close()

    const repository = new LegacyReadRepository(path)
    repositories.push(repository)
    expect((await repository.allTasks('team-a')).length).toBe(2002)
    expect((await repository.allTasksBySession('a-session', 'team-a')).length).toBe(2002)
    expect((await repository.tasks('team-a', 2000)).length).toBe(2000)
  })

  it('reads only the requested workspace across sessions, projects, and tasks', async () => {
    const repository = new LegacyReadRepository(await fixture())
    repositories.push(repository)
    await expect(repository.sessions('team-a')).resolves.toMatchObject([{ id: 'a-session' }])
    await expect(repository.session('b-session', 'team-a')).resolves.toBeNull()
    await expect(repository.projects('team-a')).resolves.toMatchObject([{ id: 'a-project' }])
    await expect(repository.project('b-project', 'team-a')).resolves.toBeNull()
    await expect(repository.projectByPlugin('missing', 'team-a')).resolves.toBeNull()
    await expect(repository.pluginSessions('plugin-a', 'team-a')).resolves.toMatchObject([
      { id: 'a-session', external_chat_id: 'chat-a', workspace_id: 'team-a' }
    ])
    await expect(repository.pluginSessions('plugin-b', 'team-a')).resolves.toEqual([])
    await expect(repository.tasks('team-a')).resolves.toMatchObject([{ id: 'a-task' }])
    await expect(repository.tasksBySession('a-session', 'team-a')).resolves.toMatchObject([
      { id: 'a-task' }
    ])
    await expect(repository.task('b-task', 'team-a')).resolves.toBeNull()
    await expect(repository.plans('team-a')).resolves.toMatchObject([
      { id: 'a-plan', workspace_id: 'team-a' }
    ])
    await expect(repository.plan('b-plan', 'team-a')).resolves.toBeNull()
    await expect(repository.planBySession('a-session', 'team-a')).resolves.toMatchObject({
      id: 'a-plan'
    })
    await expect(repository.planBySession('b-session', 'team-a')).resolves.toBeNull()
    await expect(repository.messages('a-session', 'team-a')).resolves.toMatchObject([
      { id: 'a-message' },
      { id: 'a-assistant-message' }
    ])
    await expect(repository.messages('b-session', 'team-a')).resolves.toEqual([])
    await expect(repository.userMessages('a-session', 'team-a')).resolves.toMatchObject([
      { id: 'a-message', role: 'user' }
    ])
    await expect(repository.userMessages('b-session', 'team-a')).resolves.toEqual([])
    await expect(repository.messageLocatorRows('a-session', 'team-a')).resolves.toMatchObject([
      { id: 'a-message' },
      { id: 'a-assistant-message' }
    ])
    await expect(repository.messageLocatorRows('b-session', 'team-a')).resolves.toEqual([])
    await expect(repository.messagesPage('a-session', 'team-a', 1, 1)).resolves.toMatchObject([
      { id: 'a-assistant-message' }
    ])
    await expect(repository.messagesPage('b-session', 'team-a', 1, 0)).resolves.toEqual([])
    await expect(repository.messageMarkers('a-session', 'team-a')).resolves.toMatchObject([
      { id: 'a-message' },
      { id: 'a-assistant-message' }
    ])
    await expect(repository.messageMarkers('b-session', 'team-a')).resolves.toEqual([])
    await expect(repository.messageCount('a-session', 'team-a')).resolves.toBe(2)
    await expect(repository.messageCount('b-session', 'team-a')).resolves.toBe(0)
    await expect(repository.messageRequestContext('a-session', 'team-a', 1)).resolves.toMatchObject(
      [{ id: 'a-assistant-message' }]
    )
    await expect(
      repository.messageWindowAround('a-session', 'team-a', {
        messageId: 'a-message',
        limit: 1
      })
    ).resolves.toMatchObject({
      success: true,
      start: 0,
      end: 1,
      total: 2,
      anchorSortOrder: 0,
      rows: [{ id: 'a-message' }]
    })
    await expect(
      repository.messageWindowAround('b-session', 'team-a', { limit: 30 })
    ).resolves.toMatchObject({ success: true, rows: [], total: 0 })
    await expect(repository.searchMessageContent('ans', 'team-a')).resolves.toEqual([
      { session_id: 'a-session', snippet: 'answer' }
    ])
    await expect(repository.searchMessageContent('hid', 'team-a')).resolves.toEqual([])
  })

  it('has no generic SQL path and rejects malformed workspace locators', async () => {
    const repository = new LegacyReadRepository(await fixture())
    repositories.push(repository)
    await expect(repository.sessions('', 1)).rejects.toThrow('INVALID_LEGACY_REQUEST')
    await expect(repository.projects('team-a', 2001)).rejects.toThrow('INVALID_LEGACY_REQUEST')
  })
})
