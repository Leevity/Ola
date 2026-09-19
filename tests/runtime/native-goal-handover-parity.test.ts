import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker } from '../../scripts/verify-message-windowing.mjs'
import { createLegacyDatabaseHandoverSnapshot } from '../../src/runtime/storage/legacy-database-handover'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'

interface GoalRow {
  session_id: string
  goal_id: string
  objective: string
  status: string
  token_budget: number | null
  tokens_used: number
  time_used_seconds: number
  created_at: number
  updated_at: number
}

interface GoalEventRow {
  goal_id: string | null
  event_type: string
  message: string | null
  metadata_json: string | null
}

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

describe('real Native Goal and TS handover write parity', () => {
  it('matches create, usage, objective, budget, replace and clear results and events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-native-goal-handover-'))
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
          id: 'session-a',
          title: 'Goal parity',
          mode: 'chat',
          workspaceId: 'team-a'
        })
      ).success
    ).toBe(true)
    const snapshot = await createLegacyDatabaseHandoverSnapshot({
      sourcePath: dbPath,
      backupDirectory: join(directory, 'backup')
    })
    const repository = new BusinessRepository({
      path: snapshot.backupPath,
      handoverManifestPath: snapshot.manifestPath
    })
    cleanup.push(() => repository.close())
    const native = (method: string, args: Record<string, unknown> = {}) =>
      client.request(method, { dbPath, sessionId: 'session-a', ...args })
    const check = async (expected: GoalRow | null): Promise<void> => {
      expect(await repository.goal<GoalRow>('session-a', 'team-a')).toEqual(expected)
      const nativeEvents = (await native('db/goal-events-list')) as GoalEventRow[]
      const tsEvents = await repository.goalEvents<GoalEventRow>('session-a', 'team-a')
      const comparable = (events: GoalEventRow[]) =>
        events
          .map((event) => [event.goal_id, event.event_type, event.message, event.metadata_json])
          .map((event) => JSON.stringify(event))
          .sort()
      expect(comparable(tsEvents)).toEqual(comparable(nativeEvents))
      expect(await repository.goal('session-a', 'local-personal')).toBeNull()
      expect(await repository.goalEvents('session-a', 'local-personal')).toEqual([])
    }

    const created = (
      await native('db/goals-create', {
        objective: 'First objective',
        tokenBudget: 10
      })
    ).goal as GoalRow
    expect(
      await repository.createGoal<GoalRow>({
        sessionId: 'session-a',
        workspaceId: 'team-a',
        goalId: created.goal_id,
        objective: 'First objective',
        tokenBudget: 10,
        createdAt: created.created_at
      })
    ).toEqual(created)
    await check(created)
    const scopedEvents = await repository.goalEvents<GoalEventRow>('session-a', 'team-a', {
      goalId: created.goal_id,
      limit: 1
    })
    const nativeScopedEvents = (await native('db/goal-events-list', {
      goalId: created.goal_id,
      limit: 1
    })) as GoalEventRow[]
    expect(scopedEvents.map((event) => event.event_type)).toEqual(
      nativeScopedEvents.map((event) => event.event_type)
    )
    expect(scopedEvents).toHaveLength(1)

    const unboundEvent = (await native('db/goal-events-add', {
      eventType: 'completion_deferred',
      message: 'Awaiting confirmation',
      metadata: {}
    })) as GoalEventRow & { id: string; created_at: number }
    expect(unboundEvent.goal_id).toBeNull()
    expect(unboundEvent.metadata_json).toBeNull()
    expect(
      await repository.appendGoalEvent({
        id: unboundEvent.id,
        sessionId: 'session-a',
        workspaceId: 'team-a',
        eventType: 'completion_deferred',
        message: 'Awaiting confirmation',
        metadata: {},
        createdAt: unboundEvent.created_at
      })
    ).toBe(true)
    await check(created)

    const accounted = (
      await native('db/goals-account', {
        timeDeltaSeconds: 2,
        tokenDelta: 10,
        expectedGoalId: created.goal_id
      })
    ).goal as GoalRow
    expect(
      await repository.accountGoalUsage<GoalRow>({
        sessionId: 'session-a',
        workspaceId: 'team-a',
        timeDeltaSeconds: 2,
        tokenDelta: 10,
        expectedGoalId: created.goal_id,
        updatedAt: accounted.updated_at
      })
    ).toEqual(accounted)
    await check(accounted)

    const objectiveUpdated = (
      await native('db/goals-update', {
        patch: { objective: 'Second objective' }
      })
    ).goal as GoalRow
    expect(
      await repository.updateGoal<GoalRow>({
        sessionId: 'session-a',
        workspaceId: 'team-a',
        patch: { objective: 'Second objective' },
        goalId: objectiveUpdated.goal_id,
        updatedAt: objectiveUpdated.updated_at
      })
    ).toEqual(objectiveUpdated)
    await check(objectiveUpdated)

    const budgetUpdated = (
      await native('db/goals-update', {
        patch: { status: 'paused', tokenBudget: 5 }
      })
    ).goal as GoalRow
    expect(
      await repository.updateGoal<GoalRow>({
        sessionId: 'session-a',
        workspaceId: 'team-a',
        patch: { status: 'paused', tokenBudget: 5 },
        updatedAt: budgetUpdated.updated_at
      })
    ).toEqual(budgetUpdated)
    await check(budgetUpdated)

    const replaced = (await native('db/goals-replace', {
      objective: 'Third objective',
      status: 'active',
      tokenBudget: null
    })) as GoalRow
    expect(
      await repository.replaceGoal<GoalRow>({
        sessionId: 'session-a',
        workspaceId: 'team-a',
        goalId: replaced.goal_id,
        objective: 'Third objective',
        status: 'active',
        tokenBudget: null,
        createdAt: replaced.created_at
      })
    ).toEqual(replaced)
    await check(replaced)

    expect((await native('db/goals-clear')).cleared).toBe(true)
    await expect(
      repository.clearGoal({ sessionId: 'session-a', workspaceId: 'team-a' })
    ).resolves.toMatchObject({ success: true, cleared: true, error: null })
    await check(null)
    expect((await native('db/goals-clear')).cleared).toBe(false)
    await expect(
      repository.clearGoal({ sessionId: 'session-a', workspaceId: 'team-a' })
    ).resolves.toMatchObject({ success: true, cleared: false, error: null })
    await check(null)
  }, 30_000)
})
