import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { LegacyReadRepository } from '../../src/runtime/storage/legacy-read-repository'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

describe('Native Goal workspace listing', () => {
  it('queries only Goals owned by sessions in the requested workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-goal-workspace-'))
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
      expect(
        (await client.request('db/goals-create', { dbPath, sessionId: id, objective: id })).success
      ).toBe(true)
    }
    const list = (workspaceId: string) =>
      client.request('db/goals-list', { dbPath, workspaceId }) as Promise<
        Array<{ session_id: string }>
      >
    expect((await list('local-personal')).map((goal) => goal.session_id)).toEqual([
      'personal-session'
    ])
    expect((await list('team-a')).map((goal) => goal.session_id)).toEqual(['team-session'])
    expect(await list('team-b')).toEqual([])
    expect(await client.request('db/goals-list', { dbPath })).toEqual({
      error: 'Missing required goal field: workspaceId'
    })

    const repository = new LegacyReadRepository(dbPath)
    cleanup.push(() => repository.close())
    expect(await repository.goals('team-a')).toEqual(await list('team-a'))
    expect(await repository.goals('local-personal')).toEqual(await list('local-personal'))
    expect(await repository.goals('team-b')).toEqual([])
    const nativeGoal = await client.request('db/goals-get', {
      dbPath,
      sessionId: 'team-session'
    })
    expect(await repository.goal('team-session', 'team-a')).toEqual(nativeGoal.goal)
    expect(await repository.goal('team-session', 'local-personal')).toBeNull()
    const nativeEvents = await client.request('db/goal-events-list', {
      dbPath,
      sessionId: 'team-session',
      limit: 40
    })
    expect(
      await repository.goalEvents({ sessionId: 'team-session', workspaceId: 'team-a', limit: 40 })
    ).toEqual(nativeEvents)
    expect(
      await repository.goalEvents({
        sessionId: 'team-session',
        workspaceId: 'local-personal'
      })
    ).toEqual([])

    const denied = { dbPath, sessionId: 'team-session', workspaceId: 'local-personal' }
    const originalGoal = await client.request('db/goals-get', {
      dbPath,
      sessionId: 'team-session',
      workspaceId: 'team-a'
    })
    const originalEvents = await client.request('db/goal-events-list', {
      dbPath,
      sessionId: 'team-session',
      workspaceId: 'team-a'
    })
    for (const [method, extra] of [
      ['db/goals-get', {}],
      ['db/goals-create', { objective: 'unauthorized' }],
      ['db/goals-replace', { objective: 'unauthorized' }],
      ['db/goals-update', { patch: { objective: 'unauthorized' } }],
      ['db/goals-clear', {}],
      ['db/goals-account', { tokenDelta: 7, timeDeltaSeconds: 3 }],
      ['db/goal-events-list', {}],
      ['db/goal-events-add', { eventType: 'blocked', message: 'unauthorized' }]
    ] as const) {
      const response = await client.request(method, { ...denied, ...extra })
      expect(response, method).toMatchObject({
        error: 'Goal session does not belong to requested workspace'
      })
    }
    expect(
      await client.request('db/goals-get', {
        dbPath,
        sessionId: 'team-session',
        workspaceId: 'team-a'
      })
    ).toEqual(originalGoal)
    expect(
      await client.request('db/goal-events-list', {
        dbPath,
        sessionId: 'team-session',
        workspaceId: 'team-a'
      })
    ).toEqual(originalEvents)
  }, 30_000)
})
