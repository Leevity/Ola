import { describe, expect, it } from 'vitest'
import { createTsCronRunSpec } from '../../src/main/cron/ts-cron-agent-background'

describe('TS cron runtime submission', () => {
  it('uses the persisted explicit binding and a narrow unattended capability snapshot', () => {
    const run = createTsCronRunSpec(
      {
        jobId: 'job-1',
        sessionId: 'session-1',
        prompt: '检查项目',
        modelSource: { kind: 'local', providerId: 'provider-1', modelId: 'model-1' },
        workspaceId: 'team-a',
        workingFolder: '/tmp/project',
        maxIterations: 200,
        deliveryMode: 'desktop'
      },
      'run-1'
    )
    expect(run).toMatchObject({
      runId: 'run-1',
      workspaceId: 'team-a',
      unattended: true,
      maxTurns: 128,
      modelSource: { kind: 'local', providerId: 'provider-1', modelId: 'model-1' }
    })
    expect(run.toolNames).toEqual(['Notify', 'Read', 'Write', 'Edit', 'LS', 'Glob', 'Grep', 'Bash'])
    expect(run.prompt).toContain('检查项目')
    expect(JSON.stringify(run)).not.toContain('apiKey')
  })

  it('keeps managed workspaces and suppresses desktop delivery when requested', () => {
    const run = createTsCronRunSpec(
      {
        jobId: 'job-2',
        prompt: 'report',
        modelSource: { kind: 'ola-team', workspaceId: 'team-1', resourceId: 'resource-1' },
        deliveryMode: 'none'
      },
      'run-2'
    )
    expect(run.workspaceId).toBe('team-1')
    expect(run.toolNames).toEqual([])
  })
  it('rejects a hosted binding when its authorization scope differs from the job scope', () => {
    expect(() =>
      createTsCronRunSpec(
        {
          jobId: 'job-3',
          prompt: 'report',
          workspaceId: 'team-b',
          modelSource: { kind: 'ola-team', workspaceId: 'team-a', resourceId: 'resource-1' }
        },
        'run-3'
      )
    ).toThrow('WORKSPACE_MISMATCH')
  })
})
