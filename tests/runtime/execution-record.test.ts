import { describe, expect, it } from 'vitest'
import {
  executionRecordFromCronRun,
  executionRecordFromTsRun,
  needsExecutionAttention
} from '../../src/shared/execution-record'
import type { RunEvent, RunSummary } from '../../src/shared/runtime/contracts'

const summary: RunSummary = {
  runId: 'run-1',
  taskId: 'task-1',
  requestId: 'request-1',
  traceId: 'trace-1',
  workspaceId: 'team-a',
  sessionId: 'session-1',
  sshConnectionId: 'ssh-1',
  environmentId: 'local',
  modelSource: { kind: 'local', providerId: 'local', modelId: 'model' },
  status: 'completed',
  seq: 4,
  createdAt: 10,
  updatedAt: 30,
  unattended: false
}

function event(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  timestamp = seq
): RunEvent {
  return { runId: 'run-1', workspaceId: 'team-a', seq, traceId: 'trace-1', type, data, timestamp }
}

describe('unified execution records', () => {
  it('normalizes TS events into a redacted, bounded chat record', () => {
    const result = executionRecordFromTsRun(summary, [
      event(1, 'interaction.requested', {}),
      event(2, 'interaction.resolved', {}),
      event(3, 'file.change', { path: '/repo/a.ts', operation: 'create' }),
      event(4, 'run.status', { status: 'completed' }, 30)
    ])
    expect(result).toMatchObject({
      id: 'run-1',
      source: 'chat',
      workspaceId: 'team-a',
      title: 'task-1',
      approvalStatus: 'approved',
      finishedAt: 30,
      sshConnectionId: 'ssh-1',
      fileChanges: [{ path: '/repo/a.ts', operation: 'create', transport: 'local' }]
    })
  })

  it('normalizes Cron failure and delivery context without leaking control characters', () => {
    const result = executionRecordFromCronRun({
      id: 'cron-1',
      workspaceId: 'local-personal',
      startedAt: 10,
      status: 'failed',
      jobName: 'Nightly check',
      toolCallCount: 3,
      error: 'bad\u0000provider',
      deliveryMode: 'channel',
      deliveryTarget: 'chat-1'
    })
    expect(result).toMatchObject({
      source: 'cron',
      title: 'Nightly check',
      toolCallCount: 3,
      failedToolCallCount: 1,
      commandSummary: 'channel → chat-1',
      failureReason: 'bad provider'
    })
  })

  it.each([
    ['success', 'completed'],
    ['error', 'failed'],
    ['aborted', 'cancelled'],
    ['skipped', 'skipped'],
    ['running', 'running']
  ])('maps Cron %s to the truthful unified %s state', (inputStatus, expectedStatus) => {
    const result = executionRecordFromCronRun({
      id: 'cron-1',
      workspaceId: 'local-personal',
      startedAt: 10,
      status: inputStatus
    })
    expect(result.status).toBe(expectedStatus)
    expect(result.failedToolCallCount).toBe(expectedStatus === 'failed' ? 1 : 0)
  })

  it('uses the durable terminal timestamp when a snapshot is unavailable', () => {
    expect(executionRecordFromTsRun(summary).finishedAt).toBe(summary.updatedAt)
  })

  it('keeps the durable run state when an event snapshot is stale', () => {
    const result = executionRecordFromTsRun(summary, [
      event(1, 'run.status', { status: 'running' }, 12)
    ])
    expect(result.status).toBe('completed')
    expect(result.finishedAt).toBe(summary.updatedAt)
  })

  it('counts tool attempts once and identifies failed tool results', () => {
    const result = executionRecordFromTsRun(summary, [
      event(1, 'tool.generated', { id: 'call-1' }),
      event(2, 'tool.started', { id: 'call-1' }),
      event(3, 'tool.result', { id: 'call-1', isError: true })
    ])
    expect(result.toolCallCount).toBe(1)
    expect(result.failedToolCallCount).toBe(1)
  })

  it('ignores stale pending interactions once a run has finished', () => {
    const result = executionRecordFromTsRun(
      summary,
      [],
      [
        {
          runId: summary.runId,
          workspaceId: summary.workspaceId,
          interactionId: 'stale-approval',
          kind: 'tool-approval',
          payload: {},
          createdAt: 3
        }
      ]
    )
    expect(result.approvalStatus).toBe('not_required')
  })

  it('keeps a newer pending interaction visible after earlier approvals', () => {
    const result = executionRecordFromTsRun(
      { ...summary, status: 'waiting_interaction' },
      [event(1, 'interaction.requested', {}), event(2, 'interaction.resolved', {})],
      [
        {
          runId: summary.runId,
          workspaceId: summary.workspaceId,
          interactionId: 'approval-2',
          kind: 'tool-approval',
          payload: {},
          createdAt: 3
        }
      ]
    )
    expect(result.approvalStatus).toBe('pending')
  })

  it('does not leave a completed run pending because an old request event remains', () => {
    const result = executionRecordFromTsRun(summary, [
      event(1, 'interaction.requested', {}),
      event(2, 'run.status', { status: 'completed' }, 30)
    ])
    expect(result.approvalStatus).toBe('not_required')
  })

  it('identifies channel and team run sources from their submitted scope', () => {
    expect(
      executionRecordFromTsRun({
        ...summary,
        channelContext: { pluginId: 'feishu', chatId: 'chat-a' }
      }).source
    ).toBe('channel')
    expect(
      executionRecordFromTsRun({
        ...summary,
        teamContext: { teamName: 'review' }
      }).source
    ).toBe('team')
  })

  it('keeps a business task link distinct from the runtime submission ID', () => {
    const record = executionRecordFromTsRun({
      ...summary,
      businessTaskId: 'business-task-1',
      businessTaskTitle: 'Review task'
    })
    expect(record.runtimeTaskId).toBe('task-1')
    expect(record.businessTaskId).toBe('business-task-1')
    expect(record.title).toBe('Review task')
  })

  it('keeps completed runs out of attention and includes pending approvals and failures', () => {
    const completed = executionRecordFromTsRun(summary)
    expect(needsExecutionAttention(completed)).toBe(false)
    expect(needsExecutionAttention({ ...completed, approvalStatus: 'pending' })).toBe(true)
    expect(needsExecutionAttention({ ...completed, status: 'interrupted' })).toBe(true)
    expect(needsExecutionAttention({ ...completed, status: 'failed' })).toBe(true)
  })

  it('surfaces failed, unknown and pending Cron delivery attempts as attention', () => {
    const completed = executionRecordFromTsRun(summary)
    expect(needsExecutionAttention({ ...completed, deliveryStatus: 'failed' })).toBe(true)
    expect(needsExecutionAttention({ ...completed, deliveryStatus: 'unknown' })).toBe(true)
    expect(needsExecutionAttention({ ...completed, deliveryStatus: 'pending' })).toBe(true)
    expect(needsExecutionAttention({ ...completed, deliveryStatus: 'sent' })).toBe(false)
  })

  it('preserves an explicit rejected approval outcome', () => {
    const result = executionRecordFromTsRun(summary, [
      event(1, 'interaction.requested', {}),
      event(2, 'interaction.rejected', {}),
      event(3, 'run.status', { status: 'failed', reason: 'denied' }, 30)
    ])
    expect(result.approvalStatus).toBe('rejected')
    expect(result.failureReason).toBe('denied')
  })
})
