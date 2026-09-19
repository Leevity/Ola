import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

describe('Native usage workspace boundary', () => {
  it('backfills old usage events from persisted session ownership before rebuilding scoped activity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-usage-migration-'))
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
    expect(
      (
        await client.request('db/sessions-create', {
          dbPath,
          id: 'old-team-session',
          title: 'Old team',
          mode: 'chat',
          workspaceId: 'team-a'
        })
      ).success
    ).toBe(true)
    expect(
      (
        await client.request('db/usage-add-event', {
          dbPath,
          id: 'old-team-usage',
          created_at: 1_000,
          session_id: 'old-team-session',
          source_kind: 'chat',
          input_tokens: 10,
          workspace_id: 'team-a'
        })
      ).success
    ).toBe(true)
    await client.request('db/projects-create', {
      dbPath,
      id: 'old-team-project',
      name: 'Old project',
      workspaceId: 'team-a',
      baseDirectory: join(directory, 'projects')
    })
    expect(
      (
        await client.request('db/usage-add-event', {
          dbPath,
          id: 'old-project-usage',
          created_at: 1_000,
          project_id: 'old-team-project',
          source_kind: 'agent',
          input_tokens: 7,
          workspace_id: 'team-a'
        })
      ).success
    ).toBe(true)
    const database = new DatabaseSync(dbPath)
    try {
      database.exec(`
        DROP INDEX idx_usage_events_workspace_created;
        DROP TABLE usage_activity_daily_v2;
        DROP TABLE usage_activity_daily_models_v2;
        DROP TABLE usage_activity_daily_providers_v2;
        ALTER TABLE usage_events DROP COLUMN workspace_id;
      `)
    } finally {
      database.close()
    }
    expect((await client.request('db/initialize', { dbPath })).success).toBe(true)
    const query = { dbPath, from: 0, to: 2_000, operation: 'activity-overview' }
    expect(
      (
        await client.request('db/usage-query', {
          ...query,
          workspaceId: 'team-a'
        })
      ).row?.request_count
    ).toBe(2)
    expect(
      (
        await client.request('db/usage-query', {
          ...query,
          workspaceId: 'local-personal'
        })
      ).row?.request_count
    ).toBe(0)
  }, 30_000)

  it('attributes events to persisted sessions and isolates overview, activity, list and deletion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-usage-workspace-'))
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
    for (const [id, workspaceId] of [
      ['personal-session', 'local-personal'],
      ['team-session', 'team-a']
    ]) {
      expect(
        (
          await client.request('db/sessions-create', {
            dbPath,
            id,
            title: id,
            mode: 'chat',
            workspaceId
          })
        ).success
      ).toBe(true)
    }
    const base = {
      dbPath,
      created_at: 1_000,
      source_kind: 'chat',
      provider_id: 'provider-a',
      model_id: 'model-a',
      input_tokens: 10,
      output_tokens: 5
    }
    expect(
      (
        await client.request('db/usage-add-event', {
          ...base,
          id: 'usage-personal',
          session_id: 'personal-session',
          workspace_id: 'local-personal'
        })
      ).success
    ).toBe(true)
    expect(
      (
        await client.request('db/usage-add-event', {
          ...base,
          id: 'usage-team',
          session_id: 'team-session',
          workspace_id: 'team-a'
        })
      ).success
    ).toBe(true)
    expect(
      (
        await client.request('db/usage-add-event', {
          ...base,
          id: 'usage-team-inferred',
          session_id: 'team-session'
        })
      ).success
    ).toBe(true)
    expect(
      (
        await client.request('db/usage-add-event', {
          ...base,
          id: 'usage-spoof',
          session_id: 'team-session',
          workspace_id: 'local-personal'
        })
      ).success
    ).toBe(false)
    const query = { dbPath, from: 0, to: 2_000 }
    const personal = await client.request('db/usage-query', {
      ...query,
      operation: 'overview',
      workspaceId: 'local-personal'
    })
    const team = await client.request('db/usage-query', {
      ...query,
      operation: 'activity-overview',
      workspaceId: 'team-a'
    })
    expect(personal.row?.request_count).toBe(1)
    expect(team.row?.request_count).toBe(2)
    const teamList = await client.request('db/usage-query', {
      ...query,
      operation: 'list',
      workspaceId: 'team-a'
    })
    expect(teamList.rows?.map((row: { id: string }) => row.id).sort()).toEqual([
      'usage-team',
      'usage-team-inferred'
    ])
    const deleted = await client.request('db/usage-query', {
      ...query,
      operation: 'delete',
      workspaceId: 'team-a'
    })
    expect(deleted.deleted).toBe(2)
    const teamActivityAfterDelete = await client.request('db/usage-query', {
      ...query,
      operation: 'activity-overview',
      workspaceId: 'team-a'
    })
    expect(teamActivityAfterDelete.row?.request_count).toBe(2)
    const teamModels = await client.request('db/usage-query', {
      ...query,
      operation: 'activity-by-model',
      workspaceId: 'team-a'
    })
    expect(teamModels.rows).toEqual([
      expect.objectContaining({ model_id: 'model-a', request_count: 2 })
    ])
    const personalActivity = await client.request('db/usage-query', {
      ...query,
      operation: 'activity-overview',
      workspaceId: 'local-personal'
    })
    expect(personalActivity.row?.request_count).toBe(1)
    const personalAfter = await client.request('db/usage-query', {
      ...query,
      operation: 'list',
      workspaceId: 'local-personal'
    })
    expect(personalAfter.rows?.map((row: { id: string }) => row.id)).toEqual(['usage-personal'])
  }, 30_000)

  it('rebuilds missing scoped activity before maintenance removes old raw events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-usage-maintenance-'))
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
    for (const workspaceId of ['local-personal', 'team-a']) {
      expect(
        (
          await client.request('db/usage-add-event', {
            dbPath,
            id: `old-${workspaceId}`,
            created_at: 1_000,
            source_kind: 'chat',
            workspace_id: workspaceId,
            provider_id: 'provider-a',
            model_id: 'model-a',
            input_tokens: workspaceId === 'team-a' ? 20 : 10
          })
        ).success
      ).toBe(true)
    }
    const database = new DatabaseSync(dbPath)
    try {
      database.exec(`
        DELETE FROM usage_activity_daily_v2 WHERE workspace_id = 'team-a';
        DELETE FROM usage_activity_daily_models_v2 WHERE workspace_id = 'team-a';
        DELETE FROM usage_activity_daily_providers_v2 WHERE workspace_id = 'team-a';
      `)
    } finally {
      database.close()
    }
    const maintenance = await client.request('db/usage-maintenance', { dbPath })
    expect(maintenance.success).toBe(true)
    expect(maintenance.deleted).toBe(2)
    for (const [workspaceId, inputTokens] of [
      ['local-personal', 10],
      ['team-a', 20]
    ] as const) {
      const query = { dbPath, from: 0, to: 2_000, workspaceId }
      expect(
        (await client.request('db/usage-query', { ...query, operation: 'list' })).rows
      ).toEqual([])
      for (const operation of [
        'activity-overview',
        'activity-by-model',
        'activity-by-provider',
        'activity-daily'
      ]) {
        const result = await client.request('db/usage-query', { ...query, operation })
        const first = result.row ?? result.rows?.[0]
        expect(first).toMatchObject({ request_count: 1, input_tokens: inputTokens })
      }
    }
  }, 30_000)
})
