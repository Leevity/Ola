import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import {
  createLegacyRollbackDrill,
  createLegacyDatabaseHandoverSnapshot,
  verifyLegacyBusinessDatabaseContract,
  verifyLegacyDatabaseHandoverSnapshot
} from '../../src/runtime/storage/legacy-database-handover'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'
import { LegacyReadRepository } from '../../src/runtime/storage/legacy-read-repository'
import { handoverBusinessDatabase } from '../../src/runtime/storage/business-handover-coordinator'
import {
  getUsageByModel,
  getUsageByProvider,
  getUsageActivityOverview,
  getUsageActivityDaily,
  getUsageActivityByModel,
  getUsageActivityByProvider,
  getUsageDaily,
  getUsageOverview,
  getUsageTimeline,
  listUsageEvents
} from '../../src/main/db/usage-events-dao'
import {
  canaryGetRawUsageRows,
  canaryGetUsageActivity,
  canaryGetUsageOverview,
  canaryListUsageEvents,
  canaryListSessions,
  closeLegacyReadCanary
} from '../../src/main/db/legacy-read-canary'
import {
  closeBusinessWriteCanary,
  promoteBusinessWriteRepository
} from '../../src/main/db/business-write-canary'
import {
  applySyncDbMerge,
  captureSyncDbSnapshot,
  saveSyncDbMetadata
} from '../../src/main/db/sync-dao'
import {
  restoreBusinessHandoverIfEnabled,
  writeBusinessHandoverMarker
} from '../../src/main/db/business-handover-state'

describe('real Native Worker to TS business repository handover contract', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
  })

  it('captures the final Native write only after the legacy writer exits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-native-ordered-handover-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const originalE2eRoot = process.env.OLA_E2E_DATA_ROOT
    const originalHandoverEnabled = process.env.OLA_ENABLE_BUSINESS_HANDOVER
    cleanup.push(async () => {
      if (originalE2eRoot === undefined) delete process.env.OLA_E2E_DATA_ROOT
      else process.env.OLA_E2E_DATA_ROOT = originalE2eRoot
      if (originalHandoverEnabled === undefined) delete process.env.OLA_ENABLE_BUSINESS_HANDOVER
      else process.env.OLA_ENABLE_BUSINESS_HANDOVER = originalHandoverEnabled
    })
    await writeFile(join(directory, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
    process.env.OLA_E2E_DATA_ROOT = directory
    const { client, child } = await startWorker(directory)
    cleanup.push(async () => {
      client.close()
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await new Promise((resolve) => child.once('exit', resolve))
      }
    })
    const dbPath = join(directory, 'native.db')
    expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
    expect(
      (
        await client.request('db/sessions-create', {
          dbPath,
          id: 'older-pinned-session',
          title: 'Older pinned',
          mode: 'chat',
          workspaceId: 'local-personal',
          createdAt: 1,
          updatedAt: 1,
          pinned: true,
          taskProfile: 'quick',
          taskProfileLocked: true
        })
      ).success
    ).toBe(true)
    expect(
      (
        await client.request('db/sessions-create', {
          dbPath,
          id: 'team-session',
          title: 'Team conversation',
          mode: 'execute',
          workspaceId: 'team-a',
          createdAt: 3,
          updatedAt: 3
        })
      ).success
    ).toBe(true)
    let writerExited = false
    let nativeSessions: Array<Record<string, unknown>> = []
    let nativeTeamSessions: Array<Record<string, unknown>> = []
    let nativeSecondPage: Array<Record<string, unknown>> = []
    let nativeSession: Record<string, unknown> | null = null
    const handover = await handoverBusinessDatabase({
      sourcePath: dbPath,
      backupDirectory: join(directory, 'backups'),
      quiesceLegacyWriter: async () => {
        expect(
          (
            await client.request('db/sessions-create', {
              dbPath,
              id: 'last-native-session',
              title: 'Last Native write',
              mode: 'chat',
              workspaceId: 'local-personal'
            })
          ).success
        ).toBe(true)
        nativeSessions = await client.request('db/sessions-list', {
          dbPath,
          workspaceId: 'local-personal',
          limit: 10,
          offset: 0
        })
        nativeTeamSessions = await client.request('db/sessions-list', {
          dbPath,
          workspaceId: 'team-a',
          limit: 10,
          offset: 0
        })
        nativeSecondPage = await client.request('db/sessions-list', {
          dbPath,
          workspaceId: 'local-personal',
          limit: 1,
          offset: 1
        })
        nativeSession = (
          await client.request('db/sessions-get', {
            dbPath,
            id: 'last-native-session',
            workspaceId: 'local-personal'
          })
        ).session
        client.close()
        child.kill('SIGTERM')
        if (child.exitCode === null && child.signalCode === null)
          await new Promise((resolve) => child.once('exit', resolve))
        writerExited = true
      }
    })
    let promoted = false
    cleanup.push(async () => {
      if (promoted) await closeBusinessWriteCanary()
      else await handover.repository.close()
    })
    const legacyReader = new LegacyReadRepository(handover.snapshot.backupPath)
    cleanup.push(() => legacyReader.close())
    const tsSessions = await legacyReader.sessions('local-personal', 10, 0)
    expect(tsSessions.map((row) => row.id)).toEqual(nativeSessions.map((row) => row.id))
    const fields = [
      'id',
      'title',
      'icon',
      'mode',
      'created_at',
      'updated_at',
      'project_id',
      'working_folder',
      'ssh_connection_id',
      'plan_id',
      'pinned',
      'plugin_id',
      'external_chat_id',
      'provider_id',
      'model_id',
      'model_selection_mode',
      'model_source',
      'task_profile',
      'task_profile_locked',
      'workspace_id',
      'message_count'
    ]
    const comparable = (row: object) => {
      const values = row as Record<string, unknown>
      return Object.fromEntries(fields.map((field) => [field, values[field] ?? null]))
    }
    expect(tsSessions.map(comparable)).toEqual(nativeSessions.map(comparable))
    expect((await legacyReader.sessions('team-a', 10, 0)).map(comparable)).toEqual(
      nativeTeamSessions.map(comparable)
    )
    expect((await legacyReader.sessions('local-personal', 1, 1)).map(comparable)).toEqual(
      nativeSecondPage.map(comparable)
    )
    expect(
      comparable((await legacyReader.session('last-native-session', 'local-personal'))!)
    ).toEqual(comparable(nativeSession!))
    await expect(legacyReader.session('team-session', 'local-personal')).resolves.toBeNull()
    expect(writerExited).toBe(true)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    await expect(handover.repository.sessions<{ id: string }>('local-personal')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'last-native-session' })])
    )
    promoteBusinessWriteRepository(handover.repository, handover.snapshot.manifestPath)
    promoted = true
    await expect(
      handover.repository.createSession({
        id: 'ts-owned-session',
        title: 'TS-owned after handover',
        mode: 'chat',
        workspaceId: 'local-personal',
        createdAt: 10,
        updatedAt: 10
      })
    ).resolves.toMatchObject({ id: 'ts-owned-session', workspace_id: 'local-personal' })
    const nativeAfterPromotion = new DatabaseSync(dbPath, { readOnly: true })
    try {
      expect(
        nativeAfterPromotion.prepare("SELECT id FROM sessions WHERE id='ts-owned-session'").get()
      ).toBeUndefined()
    } finally {
      nativeAfterPromotion.close()
    }
    await expect(
      canaryListSessions({ workspaceId: 'local-personal', limit: 10, offset: 0 })
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'last-native-session' }),
        expect.objectContaining({ id: 'ts-owned-session' })
      ])
    )
    await expect(
      canaryListSessions({ workspaceId: 'team-a', limit: 10, offset: 0 })
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'team-session' })]))
    writeBusinessHandoverMarker({
      manifestPath: handover.snapshot.manifestPath,
      backupPath: handover.snapshot.backupPath
    })
    await closeBusinessWriteCanary()
    process.env.OLA_ENABLE_BUSINESS_HANDOVER = '1'
    await expect(restoreBusinessHandoverIfEnabled()).resolves.toMatchObject({
      manifestPath: handover.snapshot.manifestPath,
      backupPath: handover.snapshot.backupPath
    })
    await expect(
      canaryListSessions({ workspaceId: 'local-personal', limit: 10, offset: 0 })
    ).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'last-native-session' })])
    )
    await expect(
      verifyLegacyDatabaseHandoverSnapshot({ manifestPath: handover.snapshot.manifestPath })
    ).resolves.toMatchObject({ rollbackPath: handover.snapshot.rollbackPath })
    const restored = new DatabaseSync(handover.rollbackDrill.restoredPath, { readOnly: true })
    try {
      expect(
        restored.prepare("SELECT id FROM sessions WHERE id='last-native-session'").get()
      ).toMatchObject({ id: 'last-native-session' })
    } finally {
      restored.close()
    }
  })

  it('routes legacy sync capture, merge, and metadata through TS after promotion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-native-sync-ts-handover-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const { client, child } = await startWorker(directory)
    cleanup.push(async () => {
      client.close()
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await new Promise((resolve) => child.once('exit', resolve))
      }
    })
    const dbPath = join(directory, 'native.db')
    expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
    expect(
      (
        await client.request('db/sessions-create', {
          dbPath,
          id: 'sync-session',
          title: 'Before sync',
          mode: 'chat',
          workspaceId: 'local-personal',
          createdAt: 1,
          updatedAt: 1
        })
      ).success
    ).toBe(true)
    const handover = await handoverBusinessDatabase({
      sourcePath: dbPath,
      backupDirectory: join(directory, 'backups'),
      quiesceLegacyWriter: async () => {
        client.close()
        child.kill('SIGTERM')
        if (child.exitCode === null && child.signalCode === null)
          await new Promise((resolve) => child.once('exit', resolve))
      }
    })
    cleanup.push(() => closeBusinessWriteCanary())
    promoteBusinessWriteRepository(handover.repository, handover.snapshot.manifestPath)

    const snapshot = await captureSyncDbSnapshot('webdav')
    const session = snapshot.records.find((record) => record.recordId.includes('sync-session'))
    expect(session).toBeDefined()
    await saveSyncDbMetadata(
      'webdav',
      [{ domain: session!.domain, recordId: session!.recordId, hash: 'sync-hash' }],
      []
    )
    const value = session!.value as { table: string; row: Record<string, unknown> }
    await applySyncDbMerge({
      recordsToApply: [
        {
          ...session,
          value: { ...value, row: { ...value.row, title: 'After sync', updated_at: 2 } }
        }
      ],
      recordsToDelete: []
    })
    await expect(canaryListSessions({ workspaceId: 'local-personal' })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'sync-session', title: 'After sync' })])
    )
    const native = new DatabaseSync(dbPath, { readOnly: true })
    try {
      expect(
        native.prepare("SELECT title FROM sessions WHERE id='sync-session'").get()
      ).toMatchObject({
        title: 'Before sync'
      })
    } finally {
      native.close()
    }
  })

  it('matches Native project, plan, and task reads across workspaces', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-native-project-read-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const { client, child } = await startWorker(directory)
    cleanup.push(async () => {
      client.close()
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await new Promise((resolve) => child.once('exit', resolve))
      }
    })
    const dbPath = join(directory, 'native.db')
    expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
    for (const project of [
      { id: 'regular', name: 'Regular', workspaceId: 'team-a', updatedAt: 2 },
      {
        id: 'plugin-new',
        name: 'Plugin new',
        workspaceId: 'team-a',
        pluginId: 'plugin-a',
        updatedAt: 9
      },
      {
        id: 'plugin-pinned',
        name: 'Plugin pinned',
        workspaceId: 'team-a',
        pluginId: 'plugin-a',
        pinned: true,
        updatedAt: 3
      },
      {
        id: 'other',
        name: 'Other team',
        workspaceId: 'team-b',
        pluginId: 'plugin-a',
        updatedAt: 10
      }
    ]) {
      const created = await client.request('db/projects-create', {
        dbPath,
        ...project,
        baseDirectory: join(directory, 'projects')
      })
      expect(created.id).toBe(project.id)
    }
    const nativeProjects = (await client.request('db/projects-list', {
      dbPath,
      workspaceId: 'team-a'
    })) as Array<Record<string, unknown>>
    const nativePlugin = (
      await client.request('db/projects-find-by-plugin', {
        dbPath,
        workspaceId: 'team-a',
        pluginId: 'plugin-a'
      })
    ).project as Record<string, unknown>
    const legacyReader = new LegacyReadRepository(dbPath)
    cleanup.push(() => legacyReader.close())
    expect(await legacyReader.allProjects('team-a')).toEqual(nativeProjects)
    expect(await legacyReader.projects('team-a', 1, 1)).toEqual([nativeProjects[1]])
    expect(await legacyReader.projectByPlugin('plugin-a', 'team-a')).toEqual(nativePlugin)
    const nativeProject = (
      await client.request('db/projects-get', {
        dbPath,
        id: 'regular',
        workspaceId: 'team-a'
      })
    ).project
    expect(await legacyReader.project('regular', 'team-a')).toEqual(nativeProject)
    await expect(legacyReader.project('other', 'team-a')).resolves.toBeNull()

    for (const session of [
      { id: 's-team', workspaceId: 'team-a' },
      { id: 's-other', workspaceId: 'team-b' }
    ]) {
      expect(
        (
          await client.request('db/sessions-create', {
            dbPath,
            ...session,
            title: session.id,
            mode: 'chat'
          })
        ).success
      ).toBe(true)
    }
    for (const plan of [
      {
        id: 'plan-older',
        sessionId: 's-team',
        workspaceId: 'team-a',
        title: 'Older',
        updatedAt: 2
      },
      {
        id: 'plan-newer',
        sessionId: 's-team',
        workspaceId: 'team-a',
        title: 'Newer',
        updatedAt: 4
      },
      {
        id: 'plan-other',
        sessionId: 's-other',
        workspaceId: 'team-b',
        title: 'Other',
        updatedAt: 5
      }
    ]) {
      expect(
        (
          await client.request('db/plans-create', {
            dbPath,
            ...plan,
            createdAt: 1
          })
        ).success
      ).toBe(true)
    }
    const nativePlans = (await client.request('db/plans-list', {
      dbPath,
      workspaceId: 'team-a'
    })) as Array<Record<string, unknown>>
    expect(await legacyReader.allPlans('team-a')).toEqual(nativePlans)
    expect(await legacyReader.plans('team-a', 1, 1)).toEqual([nativePlans[1]])
    const nativePlan = (
      await client.request('db/plans-get', {
        dbPath,
        id: 'plan-older',
        workspaceId: 'team-a'
      })
    ).plan
    expect(await legacyReader.plan('plan-older', 'team-a')).toEqual(nativePlan)
    const nativeSessionPlan = (
      await client.request('db/plans-get-by-session', {
        dbPath,
        sessionId: 's-team',
        workspaceId: 'team-a'
      })
    ).plan
    expect(await legacyReader.planBySession('s-team', 'team-a')).toEqual(nativeSessionPlan)
    await expect(legacyReader.plan('plan-other', 'team-a')).resolves.toBeNull()

    for (const task of [
      {
        id: 'task-first',
        sessionId: 's-team',
        workspaceId: 'team-a',
        subject: 'First',
        sortOrder: 1,
        updatedAt: 3
      },
      {
        id: 'task-second',
        sessionId: 's-team',
        workspaceId: 'team-a',
        subject: 'Second',
        sortOrder: 2,
        updatedAt: 5
      },
      {
        id: 'task-other',
        sessionId: 's-other',
        workspaceId: 'team-b',
        subject: 'Other',
        sortOrder: 0,
        updatedAt: 6
      }
    ]) {
      expect(
        (
          await client.request('db/tasks-create', {
            dbPath,
            ...task,
            createdAt: 1
          })
        ).success
      ).toBe(true)
    }
    const nativeTasks = (await client.request('db/tasks-list-all', {
      dbPath,
      workspaceId: 'team-a'
    })) as Array<Record<string, unknown>>
    const nativeSessionTasks = (await client.request('db/tasks-list-by-session', {
      dbPath,
      workspaceId: 'team-a',
      sessionId: 's-team'
    })) as Array<Record<string, unknown>>
    expect(await legacyReader.allTasks('team-a')).toEqual(nativeTasks)
    expect(await legacyReader.tasks('team-a', 1, 1)).toEqual([nativeTasks[1]])
    expect(await legacyReader.allTasksBySession('s-team', 'team-a')).toEqual(nativeSessionTasks)
    expect(await legacyReader.tasksBySession('s-team', 'team-a', 1, 1)).toEqual([
      nativeSessionTasks[1]
    ])
    const nativeTask = (
      await client.request('db/tasks-get', {
        dbPath,
        id: 'task-first',
        workspaceId: 'team-a'
      })
    ).task
    expect(await legacyReader.task('task-first', 'team-a')).toEqual(nativeTask)
    await expect(legacyReader.task('task-other', 'team-a')).resolves.toBeNull()
  })

  it('defers anomalous message ordering to Native normalization before TS reads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-native-message-order-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const { client, child } = await startWorker(directory)
    cleanup.push(async () => {
      client.close()
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await new Promise((resolve) => child.once('exit', resolve))
      }
    })
    const dbPath = join(directory, 'native.db')
    expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
    expect(
      (
        await client.request('db/sessions-create', {
          dbPath,
          id: 's-team',
          title: 'Team',
          mode: 'chat',
          workspaceId: 'team-a'
        })
      ).success
    ).toBe(true)
    const db = new DatabaseSync(dbPath)
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at, sort_order)
                VALUES (?, ?, ?, ?, ?, ?)`
    ).run('m-assistant', 's-team', 'assistant', 'answer', 2, 7)
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at, sort_order)
                VALUES (?, ?, ?, ?, ?, ?)`
    ).run('m-user', 's-team', 'user', 'question', 1, 7)
    db.close()
    const reader = new LegacyReadRepository(dbPath)
    cleanup.push(() => reader.close())
    const nativeCount = (
      await client.request('db/messages-count', {
        dbPath,
        sessionId: 's-team'
      })
    ).count
    expect(nativeCount).toBe(0)
    expect(await reader.messageCount('s-team', 'team-a')).toBe(nativeCount)
    expect(await reader.messageCount('s-team', 'team-b')).toBe(0)
    await expect(reader.messages('s-team', 'team-a')).rejects.toThrow(
      'LEGACY_MESSAGE_SORT_REQUIRES_NATIVE_NORMALIZATION'
    )
    await expect(reader.userMessages('s-team', 'team-a')).rejects.toThrow(
      'LEGACY_MESSAGE_SORT_REQUIRES_NATIVE_NORMALIZATION'
    )
    await expect(reader.messagesPage('s-team', 'team-a', 1, 0)).rejects.toThrow(
      'LEGACY_MESSAGE_SORT_REQUIRES_NATIVE_NORMALIZATION'
    )
    await expect(reader.messageLocatorRows('s-team', 'team-a')).rejects.toThrow(
      'LEGACY_MESSAGE_SORT_REQUIRES_NATIVE_NORMALIZATION'
    )
    await expect(reader.messageMarkers('s-team', 'team-a')).rejects.toThrow(
      'LEGACY_MESSAGE_SORT_REQUIRES_NATIVE_NORMALIZATION'
    )
    await expect(reader.messageRequestContext('s-team', 'team-a', 10)).rejects.toThrow(
      'LEGACY_MESSAGE_SORT_REQUIRES_NATIVE_NORMALIZATION'
    )
    await expect(reader.messageWindowAround('s-team', 'team-a', { limit: 2 })).rejects.toThrow(
      'LEGACY_MESSAGE_SORT_REQUIRES_NATIVE_NORMALIZATION'
    )
    const nativeMessages = await client.request('db/messages-list', { dbPath, sessionId: 's-team' })
    expect(await reader.messages('s-team', 'team-a')).toEqual(nativeMessages)
    expect(await reader.userMessages('s-team', 'team-a')).toEqual(
      await client.request('db/messages-list-user', { dbPath, sessionId: 's-team' })
    )
    expect(await reader.messagesPage('s-team', 'team-a', 1, 1)).toEqual(
      await client.request('db/messages-list-page', {
        dbPath,
        sessionId: 's-team',
        limit: 1,
        offset: 1
      })
    )
    expect(await reader.messageLocatorRows('s-team', 'team-a')).toEqual(
      await client.request('db/messages-list-locator', { dbPath, sessionId: 's-team' })
    )
    expect(await reader.messageMarkers('s-team', 'team-a')).toEqual(
      await client.request('db/messages-list-markers', { dbPath, sessionId: 's-team' })
    )
    expect(await reader.messageRequestContext('s-team', 'team-a', 10)).toEqual(
      await client.request('db/messages-request-context', {
        dbPath,
        sessionId: 's-team',
        maxMessages: 10
      })
    )
    expect(await reader.messageRequestContext('s-team', 'team-a', 1, 0)).toEqual(
      await client.request('db/messages-request-context', {
        dbPath,
        sessionId: 's-team',
        maxMessages: 1,
        headLimit: 0
      })
    )
    expect(await reader.messageWindowAround('s-team', 'team-a', { limit: 2 })).toEqual(
      await client.request('db/messages-window-around', {
        dbPath,
        sessionId: 's-team',
        limit: 2
      })
    )
    const extended = new DatabaseSync(dbPath)
    const insert = extended.prepare(`INSERT INTO messages
      (id, session_id, role, content, meta, created_at, sort_order)
      VALUES (?, 's-team', ?, ?, ?, ?, ?)`)
    extended.exec('BEGIN')
    for (let index = 2; index < 26; index += 1) {
      insert.run(
        `m-${index}`,
        index % 2 === 0 ? 'user' : 'assistant',
        `message ${index}`,
        index === 5 ? '{"compactBoundary":true}' : null,
        index + 1,
        index
      )
    }
    extended.prepare('UPDATE sessions SET message_count = 26 WHERE id = ?').run('s-team')
    extended.exec('COMMIT')
    extended.close()
    expect(await reader.messageCount('s-team', 'team-a')).toBe(26)
    for (const [maxMessages, headLimit] of [
      [6, 0],
      [6, 4]
    ]) {
      expect(
        await reader.messageRequestContext('s-team', 'team-a', maxMessages, headLimit)
      ).toEqual(
        await client.request('db/messages-request-context', {
          dbPath,
          sessionId: 's-team',
          maxMessages,
          headLimit
        })
      )
    }
    expect(
      await reader.messageWindowAround('s-team', 'team-a', {
        messageId: 'm-5',
        limit: 7
      })
    ).toEqual(
      await client.request('db/messages-window-around', {
        dbPath,
        sessionId: 's-team',
        messageId: 'm-5',
        limit: 7
      })
    )
    expect(
      (
        await client.request('db/sessions-create', {
          dbPath,
          id: 's-other',
          title: 'Other',
          mode: 'chat',
          workspaceId: 'team-b'
        })
      ).success
    ).toBe(true)
    const otherDb = new DatabaseSync(dbPath)
    otherDb
      .prepare(
        `INSERT INTO messages
      (id, session_id, role, content, created_at, sort_order)
      VALUES ('m-other', 's-other', 'user', 'message other', 1, 0)`
      )
      .run()
    otherDb.close()
    const scopedSearch = await client.request('db/messages-search-content', {
      dbPath,
      query: 'message',
      workspaceId: 'team-a',
      limit: 1
    })
    expect(scopedSearch).toEqual([{ session_id: 's-team', snippet: 'message 2' }])
    expect(await reader.searchMessageContent('message', 'team-a', 1)).toEqual(scopedSearch)
    expect(
      await client.request('db/messages-search-content', { dbPath, query: 'message', limit: 1 })
    ).toEqual([{ session_id: 's-other', snippet: 'message other' }])
    await expect(reader.messages('s-team', 'team-b')).resolves.toEqual([])
  })

  it('does not stop a legacy writer when the source contract fails preflight', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-native-handover-preflight-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const sourcePath = join(directory, 'incompatible.db')
    const database = new DatabaseSync(sourcePath)
    database.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)')
    database.close()
    let quiesced = false
    await expect(
      handoverBusinessDatabase({
        sourcePath,
        backupDirectory: join(directory, 'backups'),
        quiesceLegacyWriter: async () => {
          quiesced = true
        }
      })
    ).rejects.toThrow('LEGACY_DATABASE_SCHEMA_UNSUPPORTED:sessions.title')
    expect(quiesced).toBe(false)
  })

  it('restores the immutable baseline to a separate database readable by Native Worker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-native-rollback-drill-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const { client, child } = await startWorker(directory)
    cleanup.push(async () => {
      client.close()
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await new Promise((resolve) => child.once('exit', resolve))
      }
    })
    const dbPath = join(directory, 'native.db')
    expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
    expect(
      (
        await client.request('db/sessions-create', {
          dbPath,
          id: 'before-cutover',
          title: 'Native baseline',
          mode: 'chat',
          workspaceId: 'local-personal'
        })
      ).success
    ).toBe(true)
    client.close()
    child.kill('SIGTERM')
    if (child.exitCode === null && child.signalCode === null)
      await new Promise((resolve) => child.once('exit', resolve))

    const snapshot = await createLegacyDatabaseHandoverSnapshot({
      sourcePath: dbPath,
      backupDirectory: join(directory, 'backups')
    })
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      await repository.createSession({
        id: 'ts-only',
        title: 'TS write',
        mode: 'chat',
        workspaceId: 'local-personal',
        createdAt: 2,
        updatedAt: 2
      })
    } finally {
      await repository.close()
    }
    const drill = await createLegacyRollbackDrill({
      manifestPath: snapshot.manifestPath,
      restoreDirectory: join(directory, 'restore')
    })
    expect(drill.restoredPath).not.toBe(dbPath)
    expect(drill.restoredPath).not.toBe(snapshot.backupPath)
    const ipcDirectory = await mkdtemp(join(tmpdir(), 'ola-r-'))
    cleanup.push(() => rm(ipcDirectory, { recursive: true, force: true }))
    const restoredWorker = await startWorker(ipcDirectory)
    cleanup.push(async () => {
      restoredWorker.client.close()
      if (restoredWorker.child.exitCode === null && restoredWorker.child.signalCode === null) {
        restoredWorker.child.kill('SIGTERM')
        await new Promise((resolve) => restoredWorker.child.once('exit', resolve))
      }
    })
    expect(
      (await restoredWorker.client.request('db/initialize', { dbPath: drill.restoredPath })).success
    ).toBe(true)
    const restored = new DatabaseSync(drill.restoredPath, { readOnly: true })
    try {
      expect(restored.prepare('SELECT id FROM sessions ORDER BY id').all()).toEqual([
        { id: 'before-cutover' }
      ])
    } finally {
      restored.close()
    }
    expect(
      (
        await restoredWorker.client.request('db/sessions-create', {
          dbPath: drill.restoredPath,
          id: 'native-after-restore',
          title: 'Writable recovery',
          mode: 'chat',
          workspaceId: 'local-personal'
        })
      ).success
    ).toBe(true)
  })

  it('reopens a TS-owned copy after the isolated Native writer stops', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-native-cutover-rehearsal-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const { client, child } = await startWorker(directory)
    cleanup.push(async () => {
      client.close()
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await new Promise((resolve) => child.once('exit', resolve))
      }
    })
    const dbPath = join(directory, 'native.db')
    expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
    await client.request('db/sessions-create', {
      dbPath,
      id: 'native-session',
      title: 'Before cutover',
      mode: 'chat',
      workspaceId: 'local-personal'
    })
    expect(
      (
        await client.request('db/usage-add-event', {
          dbPath,
          id: 'native-usage',
          created_at: 1_000,
          session_id: 'native-session',
          source_kind: 'chat',
          provider_id: 'provider-a',
          model_id: 'model-a',
          input_tokens: 12,
          workspace_id: 'local-personal'
        })
      ).success
    ).toBe(true)
    expect(
      (
        await client.request('db/sessions-create', {
          dbPath,
          id: 'team-usage-session',
          title: 'Team usage',
          mode: 'chat',
          workspaceId: 'team-a'
        })
      ).success
    ).toBe(true)
    expect(
      (
        await client.request('db/usage-add-event', {
          dbPath,
          id: 'team-usage',
          created_at: 750,
          session_id: 'team-usage-session',
          source_kind: 'chat',
          provider_id: 'provider-a',
          model_id: 'model-a',
          input_tokens: 99,
          workspace_id: 'team-a'
        })
      ).success
    ).toBe(true)
    expect(
      (
        await client.request('db/draw-runs-save', {
          dbPath,
          id: 'native-draw',
          workspaceId: 'team-a',
          prompt: 'Team drawing',
          providerName: 'Provider',
          modelName: 'Model',
          createdAt: 1_000,
          updatedAt: 1_000,
          imagesJson: '[]'
        })
      ).success
    ).toBe(true)
    expect(
      (
        await client.request('db/sub-agent-history-apply', {
          dbPath,
          workspaceId: 'local-personal',
          id: 'native-sub-agent-history',
          sessionId: 'native-session',
          subAgentId: 'native-agent',
          toolUseId: 'native-tool',
          name: 'Agent',
          status: 'completed',
          startedAt: 500,
          updatedAt: 1_000,
          snapshotJson: '{"source":"native"}'
        })
      ).success
    ).toBe(true)
    const journal = new DatabaseSync(dbPath)
    try {
      journal
        .prepare(
          `INSERT INTO runtime_tool_results (
        session_id,tool_use_id,run_id,tool_name,status,content_json,completed_at
      ) VALUES (?,?,?,?,?,?,?)`
        )
        .run(
          'native-session',
          'native-tool',
          'native-run',
          'Read',
          'completed',
          '{"source":"native"}',
          1_000
        )
    } finally {
      journal.close()
    }
    expect(
      (
        await client.request('db/usage-add-event', {
          dbPath,
          id: 'native-usage-b',
          created_at: 500,
          session_id: 'native-session',
          source_kind: 'agent',
          provider_id: 'provider-b',
          model_id: 'model-b',
          input_tokens: 30,
          cache_read_tokens: 5,
          cache_creation_tokens: 5,
          output_tokens: 4,
          total_cost_usd: 0.05,
          workspace_id: 'local-personal'
        })
      ).success
    ).toBe(true)
    const usageOperations = [
      'overview',
      'daily',
      'timeline',
      'by-model',
      'by-provider',
      'activity-overview',
      'activity-daily',
      'activity-by-model',
      'activity-by-provider'
    ] as const
    const nativeUsage = await Promise.all(
      usageOperations.map((operation) =>
        client.request('db/usage-query', {
          dbPath,
          operation,
          workspaceId: 'local-personal',
          from: 0,
          to: 1_000
        })
      )
    )
    const usageFilterCases = [
      { workspaceId: 'local-personal', from: 0, to: 1_000, providerId: 'provider-a' },
      { workspaceId: 'local-personal', from: 0, to: 1_000, modelId: 'model-b' },
      { workspaceId: 'local-personal', from: 0, to: 1_000, sourceKind: 'agent' },
      {
        workspaceId: 'local-personal',
        from: 0,
        to: 1_000,
        providerId: 'provider-b',
        modelId: 'model-b',
        sourceKind: 'agent'
      },
      {
        workspaceId: 'local-personal',
        from: 0,
        to: 1_000,
        providerId: 'provider-a',
        modelId: 'model-b',
        sourceKind: 'agent'
      },
      { workspaceId: 'local-personal', from: 1_000, to: 1_000 },
      { workspaceId: 'local-personal', from: 1_001, to: 1_999 },
      { workspaceId: 'team-a', from: 0, to: 1_000 }
    ]
    const nativeFilteredUsage = await Promise.all(
      usageFilterCases.map((query) =>
        client.request('db/usage-query', { dbPath, operation: 'overview', ...query })
      )
    )
    const nativeUsagePage = await client.request('db/usage-query', {
      dbPath,
      operation: 'list',
      workspaceId: 'local-personal',
      from: 0,
      to: 1_000,
      limit: 1,
      offset: 1
    })
    const nativeHourlyUsage = await client.request('db/usage-query', {
      dbPath,
      operation: 'timeline',
      workspaceId: 'local-personal',
      from: 0,
      to: 1_000,
      bucket: 'hour'
    })
    const nativeFilteredModelUsage = await client.request('db/usage-query', {
      dbPath,
      operation: 'by-model',
      workspaceId: 'local-personal',
      from: 0,
      to: 1_000,
      providerId: 'provider-b'
    })
    const nativeActivityModelPage = await client.request('db/usage-query', {
      dbPath,
      operation: 'activity-by-model',
      workspaceId: 'local-personal',
      from: 0,
      to: 1_000,
      limit: 1,
      offset: 1
    })
    const nativeActivityProviderPage = await client.request('db/usage-query', {
      dbPath,
      operation: 'activity-by-provider',
      workspaceId: 'local-personal',
      from: 0,
      to: 1_000,
      limit: 1,
      offset: 1
    })
    const originalReadFlag = process.env.OLA_TS_LEGACY_READS
    const originalUsageEventFlag = process.env.OLA_TS_USAGE_EVENT_READS
    const originalUsageAnalyticsFlag = process.env.OLA_TS_USAGE_ANALYTICS_READS
    const originalReadPath = process.env.OLA_TS_LEGACY_READ_PATH
    process.env.OLA_TS_LEGACY_READS = '1'
    process.env.OLA_TS_LEGACY_READ_PATH = dbPath
    try {
      const directOverview = await canaryGetUsageOverview<Record<string, unknown>>({
        workspaceId: 'local-personal',
        from: 0,
        to: 1_000
      })
      for (const field of [
        'request_count',
        'input_tokens',
        'billable_input_tokens',
        'total_input_tokens',
        'output_tokens',
        'total_cost_usd',
        'avg_ttft_ms'
      ]) {
        expect(directOverview?.[field], `live overview ${field}`).toBe(nativeUsage[0].row?.[field])
      }
      expect((await getUsageOverview({ from: 0, to: 1_000 })).request_count).toBe(2)
      for (const [index, operation] of (
        ['daily', 'timeline', 'by-model', 'by-provider'] as const
      ).entries()) {
        const directRows = await canaryGetRawUsageRows<Record<string, unknown>>(operation, {
          workspaceId: 'local-personal',
          from: 0,
          to: 1_000
        })
        expect(directRows, `live ${operation}`).toEqual(nativeUsage[index + 1].rows)
      }
      expect(await getUsageDaily({ from: 0, to: 1_000 })).toEqual(nativeUsage[1].rows)
      expect(await getUsageTimeline({ from: 0, to: 1_000 }, 'day')).toEqual(nativeUsage[2].rows)
      expect(await getUsageByModel({ from: 0, to: 1_000 })).toEqual(nativeUsage[3].rows)
      expect(await getUsageByProvider({ from: 0, to: 1_000 })).toEqual(nativeUsage[4].rows)
      expect(
        await canaryGetRawUsageRows<Record<string, unknown>>('timeline', {
          workspaceId: 'local-personal',
          from: 0,
          to: 1_000,
          bucket: 'hour'
        })
      ).toEqual(nativeHourlyUsage.rows)
      expect(await getUsageTimeline({ from: 0, to: 1_000 }, 'hour')).toEqual(nativeHourlyUsage.rows)
      expect(await getUsageByModel({ from: 0, to: 1_000, providerId: 'provider-b' })).toEqual(
        nativeFilteredModelUsage.rows
      )
      for (const [index, operation] of (
        [
          'activity-overview',
          'activity-daily',
          'activity-by-model',
          'activity-by-provider'
        ] as const
      ).entries()) {
        const direct = await canaryGetUsageActivity<Record<string, unknown>>(operation, {
          workspaceId: 'local-personal',
          from: 0,
          to: 1_000
        })
        expect(direct, `live ${operation}`).toEqual(
          operation === 'activity-overview'
            ? { row: nativeUsage[index + 5].row }
            : { rows: nativeUsage[index + 5].rows }
        )
      }
      expect(await getUsageActivityOverview({ from: 0, to: 1_000 })).toEqual(nativeUsage[5].row)
      expect(await getUsageActivityDaily({ from: 0, to: 1_000 })).toEqual(nativeUsage[6].rows)
      expect(await getUsageActivityByModel({ from: 0, to: 1_000 })).toEqual(nativeUsage[7].rows)
      expect(await getUsageActivityByProvider({ from: 0, to: 1_000 })).toEqual(nativeUsage[8].rows)
      expect(await getUsageActivityByModel({ from: 0, to: 1_000, limit: 1, offset: 1 })).toEqual(
        nativeActivityModelPage.rows
      )
      expect(await getUsageActivityByProvider({ from: 0, to: 1_000, limit: 1, offset: 1 })).toEqual(
        nativeActivityProviderPage.rows
      )
      const directCanaryPage = await canaryListUsageEvents<{ id: string }>({
        workspaceId: 'local-personal',
        from: 0,
        to: 1_000,
        limit: 1,
        offset: 1
      })
      expect(directCanaryPage?.map((row) => row.id)).toEqual(
        nativeUsagePage.rows?.map((row: { id: string }) => row.id)
      )
      delete process.env.OLA_TS_LEGACY_READS
      delete process.env.OLA_TS_USAGE_EVENT_READS
      delete process.env.OLA_TS_USAGE_ANALYTICS_READS
      expect(
        (
          await canaryGetUsageOverview<Record<string, unknown>>({
            workspaceId: 'local-personal',
            from: 0,
            to: 1_000
          })
        )?.request_count
      ).toBe(nativeUsage[0].row?.request_count)
      for (const [index, operation] of (
        ['daily', 'timeline', 'by-model', 'by-provider'] as const
      ).entries()) {
        await expect(
          canaryGetRawUsageRows(operation, {
            workspaceId: 'local-personal',
            from: 0,
            to: 1_000
          })
        ).resolves.toEqual(nativeUsage[index + 1].rows)
      }
      for (const [index, operation] of (
        [
          'activity-overview',
          'activity-daily',
          'activity-by-model',
          'activity-by-provider'
        ] as const
      ).entries()) {
        await expect(
          canaryGetUsageActivity(operation, {
            workspaceId: 'local-personal',
            from: 0,
            to: 1_000
          })
        ).resolves.toEqual(
          operation === 'activity-overview'
            ? { row: nativeUsage[index + 5].row }
            : { rows: nativeUsage[index + 5].rows }
        )
      }
      expect(
        (
          await canaryListUsageEvents<{ id: string }>({
            workspaceId: 'local-personal',
            from: 0,
            to: 1_000,
            limit: 1,
            offset: 1
          })
        )?.map((row) => row.id)
      ).toEqual(nativeUsagePage.rows?.map((row: { id: string }) => row.id))
      process.env.OLA_TS_USAGE_EVENT_READS = '0'
      await expect(
        canaryListUsageEvents({ workspaceId: 'local-personal', from: 0, to: 1_000 })
      ).resolves.toBeUndefined()
      process.env.OLA_TS_USAGE_ANALYTICS_READS = '0'
      await expect(
        canaryGetUsageOverview({ workspaceId: 'local-personal', from: 0, to: 1_000 })
      ).resolves.toBeUndefined()
      await expect(
        canaryGetRawUsageRows('daily', { workspaceId: 'local-personal', from: 0, to: 1_000 })
      ).resolves.toBeUndefined()
      await expect(
        canaryGetUsageActivity('activity-overview', {
          workspaceId: 'local-personal',
          from: 0,
          to: 1_000
        })
      ).resolves.toBeUndefined()
      delete process.env.OLA_TS_USAGE_EVENT_READS
      delete process.env.OLA_TS_USAGE_ANALYTICS_READS
      expect(
        (
          await canaryListUsageEvents<{ id: string }>({
            workspaceId: 'team-a',
            from: 0,
            to: 1_000
          })
        )?.map((row) => row.id)
      ).toEqual(['team-usage'])
      const livePage = await listUsageEvents({
        workspaceId: 'local-personal',
        from: 0,
        to: 1_000,
        limit: 1,
        offset: 1
      })
      expect(livePage.map((row) => row.id)).toEqual(
        nativeUsagePage.rows?.map((row: { id: string }) => row.id)
      )
      for (const field of [
        'created_at',
        'session_id',
        'source_kind',
        'provider_id',
        'model_id',
        'input_tokens',
        'total_cost_usd',
        'request_debug_chars'
      ] as const) {
        expect(livePage[0]?.[field], `live usage ${field}`).toBe(nativeUsagePage.rows?.[0]?.[field])
      }
      expect(
        (
          await listUsageEvents({
            workspaceId: 'local-personal',
            from: 0,
            to: 1_000,
            providerId: 'provider-b'
          })
        ).map((row) => row.id)
      ).toEqual(['native-usage-b'])
      await expect(listUsageEvents({ workspaceId: 'team-a', from: 0, to: 1_000 })).rejects.toThrow(
        'Usage workspace is not available'
      )
    } finally {
      await closeLegacyReadCanary()
      if (originalReadFlag === undefined) delete process.env.OLA_TS_LEGACY_READS
      else process.env.OLA_TS_LEGACY_READS = originalReadFlag
      if (originalUsageEventFlag === undefined) delete process.env.OLA_TS_USAGE_EVENT_READS
      else process.env.OLA_TS_USAGE_EVENT_READS = originalUsageEventFlag
      if (originalUsageAnalyticsFlag === undefined) delete process.env.OLA_TS_USAGE_ANALYTICS_READS
      else process.env.OLA_TS_USAGE_ANALYTICS_READS = originalUsageAnalyticsFlag
      if (originalReadPath === undefined) delete process.env.OLA_TS_LEGACY_READ_PATH
      else process.env.OLA_TS_LEGACY_READ_PATH = originalReadPath
    }
    const snapshot = await createLegacyDatabaseHandoverSnapshot({
      sourcePath: dbPath,
      backupDirectory: join(directory, 'backups')
    })
    client.close()
    child.kill('SIGTERM')
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve))

    const firstOwner = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    try {
      await expect(firstOwner.drawRuns('team-a')).resolves.toEqual([
        expect.objectContaining({ id: 'native-draw', workspace_id: 'team-a' })
      ])
      await expect(
        firstOwner.subAgentHistoryPage({
          sessionId: 'native-session',
          workspaceId: 'local-personal'
        })
      ).resolves.toMatchObject({
        items: [expect.objectContaining({ id: 'native-sub-agent-history' })]
      })
      await expect(
        firstOwner.runtimeToolResults('native-session', 'local-personal', ['native-tool'])
      ).resolves.toEqual([expect.objectContaining({ contentJson: '{"source":"native"}' })])
      for (const [index, operation] of usageOperations.entries()) {
        const native = nativeUsage[index]
        const result = operation.startsWith('activity-')
          ? await firstOwner.queryActivityUsage<Record<string, unknown>>(
              operation as
                | 'activity-overview'
                | 'activity-daily'
                | 'activity-by-model'
                | 'activity-by-provider',
              { workspaceId: 'local-personal', from: 0, to: 1_000 }
            )
          : await firstOwner.queryRawUsage<Record<string, unknown>>(
              operation as 'overview' | 'daily' | 'timeline' | 'by-model' | 'by-provider',
              { workspaceId: 'local-personal', from: 0, to: 1_000 }
            )
        const nativeRows = native.row ? [native.row] : native.rows
        const tsRows = result.row ? [result.row] : result.rows
        expect(tsRows?.length).toBe(nativeRows?.length)
        for (let rowIndex = 0; rowIndex < (nativeRows?.length ?? 0); rowIndex++) {
          for (const field of [
            'request_count',
            'input_tokens',
            'billable_input_tokens',
            'total_input_tokens',
            'output_tokens',
            'cache_creation_tokens',
            'cache_read_tokens',
            'reasoning_tokens',
            'total_cost_usd',
            'avg_ttft_ms',
            'avg_total_ms',
            'day',
            'bucket_label',
            'model_id',
            'provider_id'
          ]) {
            if (field in (nativeRows?.[rowIndex] ?? {}))
              expect(tsRows?.[rowIndex]?.[field], `${operation}.${field}`).toBe(
                nativeRows?.[rowIndex]?.[field]
              )
          }
        }
      }
      for (const [index, query] of usageFilterCases.entries()) {
        const native = nativeFilteredUsage[index].row as Record<string, unknown> | undefined
        const result = await firstOwner.queryRawUsage<Record<string, unknown>>('overview', query)
        expect(result.row?.request_count, `usage filter ${index}`).toBe(native?.request_count)
        expect(result.row?.input_tokens, `usage filter ${index}`).toBe(native?.input_tokens)
        expect(result.row?.total_cost_usd, `usage filter ${index}`).toBe(native?.total_cost_usd)
      }
      const tsUsagePage = await firstOwner.usageEvents<{ id: string }>({
        workspaceId: 'local-personal',
        from: 0,
        to: 1_000,
        limit: 1,
        offset: 1
      })
      expect(tsUsagePage.map((row) => row.id)).toEqual(
        nativeUsagePage.rows?.map((row: { id: string }) => row.id)
      )
      await expect(
        firstOwner.createSession<{ id: string }>({
          id: 'ts-session',
          title: 'After cutover',
          mode: 'chat',
          workspaceId: 'local-personal',
          createdAt: 2,
          updatedAt: 2
        })
      ).resolves.toMatchObject({ id: 'ts-session' })
      await expect(
        firstOwner.addUsageEvent({
          id: 'ts-usage',
          workspace_id: 'local-personal',
          created_at: 2_000,
          session_id: 'ts-session',
          source_kind: 'chat',
          input_tokens: 8
        })
      ).resolves.toMatchObject({ id: 'ts-usage' })
    } finally {
      await firstOwner.close()
    }
    const restartedOwner = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    cleanup.push(() => restartedOwner.close())
    await expect(restartedOwner.sessions<{ id: string }>('local-personal')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'native-session' }),
        expect.objectContaining({ id: 'ts-session' })
      ])
    )
    await expect(
      restartedOwner.usageEvents<{ id: string }>({
        workspaceId: 'local-personal',
        from: 0,
        to: 2_000
      })
    ).resolves.toEqual([
      expect.objectContaining({ id: 'ts-usage', input_tokens: 8 }),
      expect.objectContaining({ id: 'native-usage', input_tokens: 12 }),
      expect.objectContaining({ id: 'native-usage-b', input_tokens: 30 })
    ])
    const localEpoch = new Date(0)
    const localEpochDay = [
      localEpoch.getFullYear(),
      String(localEpoch.getMonth() + 1).padStart(2, '0'),
      String(localEpoch.getDate()).padStart(2, '0')
    ].join('-')
    await expect(
      restartedOwner.usageActivity<{ request_count: number }>({
        workspaceId: 'local-personal',
        fromDay: localEpochDay,
        toDay: localEpochDay,
        dimension: 'daily'
      })
    ).resolves.toEqual([expect.objectContaining({ request_count: 3, input_tokens: 40 })])
    const original = new DatabaseSync(dbPath, { readOnly: true })
    try {
      expect(original.prepare('SELECT id FROM sessions ORDER BY id').all()).toEqual([
        { id: 'native-session' },
        { id: 'team-usage-session' }
      ])
    } finally {
      original.close()
    }
  }, 30_000)

  it('backs up a real Native schema and reads it through the isolated TS owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-native-handover-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const { client, child } = await startWorker(directory)
    cleanup.push(async () => {
      client.close()
      child.kill('SIGTERM')
      if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve))
    })
    const dbPath = join(directory, 'native.db')
    expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
    await client.request('db/projects-create', {
      dbPath,
      id: 'p-team',
      name: 'Team project',
      workspaceId: 'team-a',
      baseDirectory: join(directory, 'projects')
    })
    await client.request('db/sessions-create', {
      dbPath,
      id: 's-team',
      title: 'Team session',
      mode: 'chat',
      workspaceId: 'team-a',
      projectId: 'p-team'
    })
    const memoryRoot = await client.request('db/memory-roots-ensure', {
      dbPath,
      workspaceId: 'team-a',
      scope: 'project',
      projectId: 'p-team',
      workingFolder: '/team/project',
      rootPath: '/team/project/.agents/workspaces/team-a',
      transport: 'local'
    })
    expect(memoryRoot).toMatchObject({ workspaceId: 'team-a' })
    const rootId = memoryRoot.id as string
    expect(
      await client.request('db/memory-stage1-add', {
        dbPath,
        workspaceId: 'team-a',
        memoryRootId: rootId,
        scope: 'project',
        sourceSessionId: 's-team',
        rawMemory: 'Team decision',
        rolloutSummary: 'Decision',
        rolloutSlug: 'team-decision',
        fingerprint: 'team-decision-v1'
      })
    ).toMatchObject({ rawMemory: 'Team decision' })
    const memoryJob = await client.request('db/memory-jobs-create', {
      dbPath,
      workspaceId: 'team-a',
      kind: 'phase2',
      status: 'succeeded',
      memoryRootId: rootId,
      sourceSessionId: 's-team'
    })
    expect(memoryJob).toMatchObject({ workspaceId: 'team-a' })
    const memoryEntry = await client.request('db/memory-automation-add', {
      dbPath,
      workspaceId: 'team-a',
      scope: 'main',
      rootScope: 'project',
      memoryRootId: rootId,
      jobId: memoryJob.id,
      projectId: 'p-team',
      target: 'project_memory',
      kind: 'project_decision',
      content: 'Team decision',
      sourceSessionId: 's-team',
      status: 'written',
      fingerprint: 'team-decision-v1'
    })
    expect(memoryEntry).toMatchObject({ success: true })
    expect(
      await client.request('db/memory-automation-rollup-mark', {
        dbPath,
        workspaceId: 'team-a',
        scope: 'main',
        target: 'project_memory',
        targetPath: '/team/project/MEMORY.md',
        sourceDate: '2026-09-17',
        contentHash: 'team-hash'
      })
    ).toMatchObject({ success: true })
    expect(
      await client.request('db/memory-citation-record', {
        dbPath,
        workspaceId: 'team-a',
        memoryRootId: rootId,
        scope: 'project',
        sourceSessionId: 's-team',
        path: '/team/project/MEMORY.md'
      })
    ).toMatchObject({ success: true })
    expect(
      (
        await client.request('db/plans-create', {
          dbPath,
          id: 'plan-team',
          sessionId: 's-team',
          workspaceId: 'team-a',
          title: 'Team plan',
          status: 'drafting',
          createdAt: 1,
          updatedAt: 1
        })
      ).success
    ).toBe(true)
    expect(
      (
        await client.request('db/cron-jobs-create', {
          dbPath,
          job: {
            id: 'cron-team',
            workspace_id: 'team-a',
            session_id: 's-team',
            name: 'Team cron',
            schedule_kind: 'every',
            schedule_every: 60_000,
            prompt: 'Keep working'
          }
        })
      ).success
    ).toBe(true)
    expect(
      (
        await client.request('db/cron-runs-create', {
          dbPath,
          runId: 'native-run',
          jobId: 'cron-team',
          startedAt: 2,
          jobNameSnapshot: 'Team cron',
          promptSnapshot: 'Keep working'
        })
      ).success
    ).toBe(true)
    expect(
      (
        await client.request('db/cron-run-messages-replace', {
          dbPath,
          runId: 'native-run',
          messages: [
            {
              id: 'native-message',
              role: 'assistant',
              content: { text: 'Native reply' },
              createdAt: 3
            }
          ]
        })
      ).success
    ).toBe(true)
    expect(
      (
        await client.request('db/cron-run-log-append', {
          dbPath,
          runId: 'native-run',
          id: 'native-log',
          timestamp: 3,
          type: 'text',
          content: 'Native logged'
        })
      ).success
    ).toBe(true)

    await expect(
      verifyLegacyBusinessDatabaseContract({ sourcePath: dbPath })
    ).resolves.toMatchObject({
      sourcePath: dbPath
    })
    const snapshot = await createLegacyDatabaseHandoverSnapshot({
      sourcePath: dbPath,
      backupDirectory: join(directory, 'backups')
    })
    await expect(
      verifyLegacyDatabaseHandoverSnapshot({ manifestPath: snapshot.manifestPath })
    ).resolves.toMatchObject({ backupPath: snapshot.backupPath })

    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    cleanup.push(() => repository.close())
    await expect(repository.sessions<{ id: string }>('team-a')).resolves.toEqual([
      expect.objectContaining({ id: 's-team' })
    ])
    await expect(repository.sessions('local-personal')).resolves.toEqual([])
    await expect(repository.projects<{ id: string }>('team-a')).resolves.toEqual([
      expect.objectContaining({ id: 'p-team' })
    ])
    await expect(repository.memoryRoot<{ id: string }>(rootId, 'team-a')).resolves.toMatchObject({
      id: rootId,
      workspace_id: 'team-a'
    })
    await expect(repository.memoryRoot(rootId, 'local-personal')).resolves.toBeNull()
    await expect(
      repository.memoryStage1Outputs<{ raw_memory: string }>(rootId, 'team-a')
    ).resolves.toEqual([expect.objectContaining({ raw_memory: 'Team decision' })])
    await expect(repository.memoryStage1Outputs(rootId, 'local-personal')).resolves.toEqual([])
    await expect(
      repository.ensureMemoryRoot({
        workspaceId: 'team-a',
        scope: 'project',
        projectId: 'p-team',
        workingFolder: '/team/project',
        rootPath: '/team/project/.agents/workspaces/team-a',
        transport: 'local'
      })
    ).resolves.toMatchObject({ id: rootId })
    await expect(
      repository.addMemoryStage1Output({
        workspaceId: 'team-a',
        memoryRootId: rootId,
        scope: 'project',
        sourceSessionId: 's-team',
        rawMemory: 'Updated after handover',
        rolloutSummary: 'Decision',
        rolloutSlug: 'team-decision',
        fingerprint: 'team-decision-v1'
      })
    ).resolves.toMatchObject({ raw_memory: 'Updated after handover' })
    await expect(
      repository.memoryStage1Outputs<{ raw_memory: string }>(rootId, 'team-a')
    ).resolves.toEqual([expect.objectContaining({ raw_memory: 'Updated after handover' })])
    await expect(
      repository.memoryJob<{ id: string }>(memoryJob.id as string, 'team-a')
    ).resolves.toMatchObject({ id: memoryJob.id })
    await expect(repository.memoryJob(memoryJob.id as string, 'local-personal')).resolves.toBeNull()
    await expect(
      repository.memoryAutomationEntries<{ content: string }>('team-a')
    ).resolves.toEqual([expect.objectContaining({ content: 'Team decision' })])
    await expect(repository.memoryAutomationEntries('local-personal')).resolves.toEqual([])
    await expect(repository.memoryRollups<{ target_path: string }>('team-a')).resolves.toEqual([
      expect.objectContaining({ target_path: '/team/project/MEMORY.md' })
    ])
    await expect(repository.memoryRollups('local-personal')).resolves.toEqual([])
    await expect(
      repository.memoryCitationUsage<{ path: string }>(rootId, 'team-a')
    ).resolves.toEqual([expect.objectContaining({ path: '/team/project/MEMORY.md' })])
    await expect(repository.memoryCitationUsage(rootId, 'local-personal')).resolves.toEqual([])
    const tsEntry = await repository.recordMemoryAutomationEntry<{ id: string }>({
      workspaceId: 'team-a',
      scope: 'main',
      rootScope: 'project',
      memoryRootId: rootId,
      jobId: memoryJob.id as string,
      projectId: 'p-team',
      target: 'project_memory',
      kind: 'project_decision',
      content: 'TS handover decision',
      sourceSessionId: 's-team',
      status: 'written',
      fingerprint: 'ts-handover-decision'
    })
    await expect(
      repository.markMemoryAutomationUndo({
        id: tsEntry.id,
        workspaceId: 'team-a',
        status: 'undone'
      })
    ).resolves.toMatchObject({ id: tsEntry.id, status: 'undone' })
    await expect(
      repository.recordMemoryCitationUsage({
        workspaceId: 'team-a',
        memoryRootId: rootId,
        scope: 'project',
        sourceSessionId: 's-team',
        path: '/team/project/MEMORY.md'
      })
    ).resolves.toBe(1)
    await expect(
      repository.markMemoryRollup({
        workspaceId: 'team-a',
        scope: 'main',
        target: 'project_memory',
        targetPath: '/team/project/MEMORY.md',
        sourceDate: '2026-09-18',
        contentHash: 'ts-handover-hash'
      })
    ).resolves.toBe(true)
    await expect(repository.memoryRollups<{ content_hash: string }>('team-a')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ content_hash: 'ts-handover-hash' })])
    )
    await expect(repository.plans<{ id: string }>('team-a')).resolves.toEqual([
      expect.objectContaining({ id: 'plan-team' })
    ])
    await expect(repository.cronJobs<{ id: string }>('team-a')).resolves.toEqual([
      expect.objectContaining({ id: 'cron-team' })
    ])
    await expect(
      repository.cronRunDetail<{
        run: { status: string; job_name_snapshot: string }
        messages: Array<{ content: string }>
        logs: Array<{ content: string }>
      }>('native-run', 'team-a')
    ).resolves.toMatchObject({
      run: { status: 'running', job_name_snapshot: 'Team cron' },
      messages: [expect.objectContaining({ content: JSON.stringify({ text: 'Native reply' }) })],
      logs: [expect.objectContaining({ content: 'Native logged' })]
    })
    const nativeCronDetail = await client.request('db/cron-run-detail', {
      dbPath,
      runId: 'native-run',
      workspaceId: 'team-a'
    })
    await expect(repository.cronRunDetail('native-run', 'team-a')).resolves.toEqual({
      run: nativeCronDetail.run,
      job: nativeCronDetail.job,
      messages: nativeCronDetail.messages,
      logs: nativeCronDetail.logs
    })
    await expect(repository.cronRunDetail('native-run', 'local-personal')).resolves.toBeNull()
    await expect(repository.recoverCronJobs('team-a', 10)).resolves.toMatchObject({
      abortedRuns: 1,
      expiredJobs: 0
    })
    await expect(
      repository.cronRunDetail<{ run: { status: string } }>('native-run', 'team-a')
    ).resolves.toMatchObject({ run: { status: 'aborted' } })
    const nativeRun = await client.request('db/cron-run-detail', {
      dbPath,
      runId: 'native-run',
      workspaceId: 'team-a'
    })
    expect(nativeRun.run.status).toBe('running')
    await repository.createCronJob({
      id: 'cron-ts-only',
      workspaceId: 'team-a',
      name: 'TS owned',
      scheduleKind: 'every',
      scheduleEvery: 60_000,
      prompt: 'Copy only',
      createdAt: 2
    })
    const nativeJobs = await client.request('db/cron-jobs-list', { dbPath, workspaceId: 'team-a' })
    expect(nativeJobs.jobs.map((job: { id: string }) => job.id)).toEqual(['cron-team'])
  }, 30_000)
})
