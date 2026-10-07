import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'
import { migrateBusinessSchema } from '../../src/runtime/storage/business-schema.mjs'
import { recoverCronSessionDeliveries } from '../../src/main/cron/cron-session-delivery'

const recoveryMocks = vi.hoisted(() => ({
  repository: null as BusinessRepository | null,
  sendEvent: vi.fn()
}))

vi.mock('../../src/main/db/business-write-canary', () => ({
  businessWriteCanary: () => recoveryMocks.repository
}))
vi.mock('../../src/main/cron/cron-workspace-events', () => ({
  sendCronWorkspaceEvent: recoveryMocks.sendEvent
}))

describe('durable Cron session delivery', () => {
  let root: string | undefined
  let repository: BusinessRepository | undefined

  afterEach(async () => {
    await repository?.close()
    if (root) await rm(root, { recursive: true, force: true })
    recoveryMocks.repository = null
    recoveryMocks.sendEvent.mockClear()
  })

  it('recovers an interrupted completed run once across repeated startups', async () => {
    root = await mkdtemp(join(tmpdir(), 'ola-cron-session-recovery-'))
    repository = new BusinessRepository({ path: join(root, 'data.db'), mode: 'direct' })
    recoveryMocks.repository = repository
    const now = Date.now() + 1_000
    await repository.createSession({
      id: 'recovery-session',
      title: 'Recovery',
      mode: 'chat',
      createdAt: now,
      updatedAt: now,
      workspaceId: 'local-personal'
    })
    await repository.createCronJob({
      id: 'recovery-job',
      workspaceId: 'local-personal',
      name: 'Recovery job',
      scheduleKind: 'at',
      scheduleAt: now + 60_000,
      prompt: 'Summarize',
      deliveryMode: 'session',
      deliveryTarget: 'recovery-session',
      createdAt: now
    })
    await repository.createCronRun({
      id: 'recovery-run',
      jobId: 'recovery-job',
      workspaceId: 'local-personal',
      startedAt: now,
      deliveryModeSnapshot: 'session',
      deliveryTargetSnapshot: 'recovery-session'
    })
    await repository.finishCronRun({
      id: 'recovery-run',
      workspaceId: 'local-personal',
      finishedAt: now + 1,
      status: 'success',
      toolCallCount: 0,
      outputSummary: 'Recovered result'
    })
    await repository.createCronRun({
      id: 'a-invalid-run',
      jobId: 'recovery-job',
      workspaceId: 'local-personal',
      startedAt: now + 2,
      deliveryModeSnapshot: 'session',
      deliveryTargetSnapshot: 'missing-session'
    })
    await repository.finishCronRun({
      id: 'a-invalid-run',
      workspaceId: 'local-personal',
      finishedAt: now + 3,
      status: 'success',
      toolCallCount: 0,
      outputSummary: 'Undeliverable result'
    })

    await recoverCronSessionDeliveries()
    await recoverCronSessionDeliveries()

    expect(
      await repository.messages<{ content: string }>('recovery-session', 'local-personal')
    ).toEqual([expect.objectContaining({ content: JSON.stringify('Recovered result') })])
    expect(recoveryMocks.sendEvent).toHaveBeenCalledTimes(1)
    expect(recoveryMocks.sendEvent).toHaveBeenCalledWith(
      'local-personal',
      'cron:session-delivered',
      { runId: 'recovery-run', sessionId: 'recovery-session' }
    )
    expect(
      await repository.cronRunDetail<{ run: { delivery_status: string } }>(
        'a-invalid-run',
        'local-personal'
      )
    ).toMatchObject({ run: { delivery_status: 'failed' } })
    expect(await repository.pendingCronSessionDeliveries()).toEqual([])
  })

  it('saves one message and one delivery outcome even when invoked concurrently', async () => {
    root = await mkdtemp(join(tmpdir(), 'ola-cron-session-delivery-'))
    repository = new BusinessRepository({ path: join(root, 'data.db'), mode: 'direct' })
    const now = Date.now() + 1_000
    await repository.createSession({
      id: 'target-session',
      title: 'Target',
      mode: 'chat',
      createdAt: now,
      updatedAt: now,
      workspaceId: 'local-personal'
    })
    await repository.createSession({
      id: 'other-workspace-session',
      title: 'Other workspace',
      mode: 'chat',
      createdAt: now,
      updatedAt: now,
      workspaceId: 'team-a'
    })
    await repository.createCronJob({
      id: 'session-job',
      workspaceId: 'local-personal',
      name: 'Session delivery',
      scheduleKind: 'at',
      scheduleAt: now + 60_000,
      prompt: 'Summarize',
      deliveryMode: 'session',
      deliveryTarget: 'target-session',
      createdAt: now
    })
    await repository.createCronRun({
      id: 'session-run',
      jobId: 'session-job',
      workspaceId: 'local-personal',
      startedAt: now,
      deliveryModeSnapshot: 'session',
      deliveryTargetSnapshot: 'target-session'
    })
    await repository.finishCronRun({
      id: 'session-run',
      workspaceId: 'local-personal',
      finishedAt: now + 1,
      status: 'success',
      toolCallCount: 0,
      outputSummary: 'Verified result'
    })
    expect(await repository.pendingCronSessionDeliveries<{ run_id: string }>()).toEqual([
      expect.objectContaining({ run_id: 'session-run' })
    ])

    const delivery = {
      runId: 'session-run',
      workspaceId: 'local-personal',
      targetSessionId: 'target-session',
      content: 'Verified result',
      createdAt: now + 2
    }
    const results = await Promise.all([
      repository.deliverCronRunToSession(delivery),
      repository.deliverCronRunToSession(delivery)
    ])
    expect(results).toEqual([
      { status: 'sent', inserted: true, errorCode: null },
      { status: 'sent', inserted: false, errorCode: null }
    ])
    expect(
      await repository.messages<{ id: string; role: string; content: string }>(
        'target-session',
        'local-personal'
      )
    ).toEqual([
      expect.objectContaining({
        id: 'cron-session-session-run',
        role: 'assistant',
        content: JSON.stringify('Verified result')
      })
    ])
    expect(
      await repository.sessionStatus({ sessionId: 'target-session', workspaceId: 'local-personal' })
    ).toMatchObject({ messageCount: 1 })
    expect(
      await repository.cronRunDetail<{
        run: { delivery_status: string }
        deliveries: Array<{ kind: string; status: string }>
      }>('session-run', 'local-personal')
    ).toMatchObject({
      run: { delivery_status: 'sent' },
      deliveries: [expect.objectContaining({ kind: 'session', status: 'sent' })]
    })
    expect(await repository.messages('other-workspace-session', 'team-a')).toEqual([])

    await repository.createCronRun({
      id: 'missing-target-run',
      jobId: 'session-job',
      workspaceId: 'local-personal',
      startedAt: now + 3,
      deliveryModeSnapshot: 'session'
    })
    await repository.finishCronRun({
      id: 'missing-target-run',
      workspaceId: 'local-personal',
      finishedAt: now + 4,
      status: 'success',
      toolCallCount: 0
    })
    expect(await repository.pendingCronSessionDeliveries<{ run_id: string }>()).toEqual([
      expect.objectContaining({ run_id: 'missing-target-run' })
    ])
    await expect(
      repository.deliverCronRunToSession({
        ...delivery,
        runId: 'missing-target-run',
        targetSessionId: 'other-workspace-session'
      })
    ).resolves.toEqual({
      status: 'failed',
      inserted: false,
      errorCode: 'TARGET_SESSION_NOT_FOUND'
    })
    expect(await repository.messages('other-workspace-session', 'team-a')).toEqual([])
    expect(await repository.pendingCronSessionDeliveries()).toEqual([])
    expect(
      await repository.cronRunDetail<{ run: { delivery_status: string } }>(
        'missing-target-run',
        'local-personal'
      )
    ).toMatchObject({ run: { delivery_status: 'failed' } })

    await repository.createCronRun({
      id: 'trial-run',
      jobId: 'session-job',
      workspaceId: 'local-personal',
      startedAt: now + 5,
      deliveryModeSnapshot: 'session',
      runKind: 'trial'
    })
    await repository.finishCronRun({
      id: 'trial-run',
      workspaceId: 'local-personal',
      finishedAt: now + 6,
      status: 'success',
      toolCallCount: 0
    })
    await expect(
      repository.deliverCronRunToSession({
        ...delivery,
        runId: 'trial-run'
      })
    ).rejects.toThrow('BUSINESS_CRON_SESSION_DELIVERY_NOT_ALLOWED')

    await repository.close()
    repository = undefined
    const database = new DatabaseSync(join(root, 'data.db'))
    try {
      database.prepare('DELETE FROM ola_ts_schema_migrations WHERE version = 11').run()
      migrateBusinessSchema(database, { direct: true })
      expect(
        database
          .prepare("SELECT kind, status FROM cron_run_deliveries WHERE run_id = 'session-run'")
          .get()
      ).toEqual({ kind: 'session', status: 'sent' })
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      database.close()
    }
  })
})
