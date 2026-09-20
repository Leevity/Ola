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

  it('binds unattended SSH work to the explicit connection and remote tool set', () => {
    const run = createTsCronRunSpec(
      {
        jobId: 'job-ssh',
        prompt: '检查远程服务',
        modelSource: { kind: 'local', providerId: 'provider-1', modelId: 'model-1' },
        workspaceId: 'local-personal',
        sshConnectionId: 'ssh-1',
        deliveryMode: 'none'
      },
      'run-ssh'
    )
    expect(run).toMatchObject({
      sshConnectionId: 'ssh-1',
      unattended: true,
      toolNames: ['Read', 'Write', 'Edit', 'LS', 'Glob', 'Grep', 'Bash']
    })
    expect(run).not.toHaveProperty('workingDirectory')
  })

  it('binds channel delivery to one explicit chat and the Main-owned send tool', () => {
    const run = createTsCronRunSpec(
      {
        jobId: 'job-channel',
        prompt: '汇报状态',
        modelSource: { kind: 'local', providerId: 'provider-1', modelId: 'model-1' },
        workspaceId: 'team-a',
        pluginId: 'feishu-1',
        pluginChatId: 'chat-1',
        deliveryMode: 'desktop'
      },
      'run-channel'
    )
    expect(run).toMatchObject({
      channelContext: { pluginId: 'feishu-1', chatId: 'chat-1' },
      toolNames: ['PluginSendMessage'],
      unattended: true
    })
    expect(run.prompt).toContain('PluginSendMessage exactly once')
  })

  it('projects a custom Main-owned agent definition into the TS run', () => {
    const run = createTsCronRunSpec(
      {
        jobId: 'job-custom',
        prompt: '检查日志',
        modelSource: { kind: 'local', providerId: 'provider-1', modelId: 'model-1' },
        workingFolder: '/tmp/project',
        deliveryMode: 'none'
      },
      'run-custom',
      {
        name: 'LogAgent',
        description: 'Log specialist',
        allowedTools: ['Read', 'Grep'],
        maxIterations: 7,
        temperature: 0.2,
        systemPrompt: 'Focus on structured log diagnosis.'
      }
    )
    expect(run).toMatchObject({
      toolNames: ['Read', 'Grep'],
      maxTurns: 7,
      modelOptions: { systemPrompt: 'Focus on structured log diagnosis.', temperature: 0.2 }
    })
    expect(run.prompt).toContain('Focus on structured log diagnosis.')
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
