import { describe, expect, it } from 'vitest'
import {
  executionRecordFromCronRun,
  executionRecordFromTsRun
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
