import { describe, expect, it } from 'vitest'
import {
  assessLegacyRunEligibility,
  projectEligibleLegacyRun
} from '../../src/runtime/core/legacy-run-eligibility'

describe('legacy request migration eligibility', () => {
  const input = {
    messages: [
      { role: 'assistant' as const, content: 'Earlier answer' },
      { role: 'user' as const, content: 'Current question' }
    ],
    modelSource: { kind: 'local', providerId: 'lan', modelId: 'model' }
  }
  it('projects a lossless pure-text local request', () => {
    expect(assessLegacyRunEligibility(input)).toEqual({
      eligible: true,
      prompt: 'Current question',
      history: [{ role: 'assistant', text: 'Earlier answer' }],
      modelSource: input.modelSource
    })
  })
  it.each([
    [{ ...input, toolCount: 1 }, 'TOOLS_NOT_MIGRATED'],
    [{ ...input, hasAttachments: true }, 'ATTACHMENTS_NOT_MIGRATED'],
    [{ ...input, hasPlan: true }, 'PLAN_NOT_MIGRATED'],
    [{ ...input, sshConnectionId: 'ssh-1' }, 'SSH_NOT_MIGRATED'],
    [{ ...input, modelSource: { kind: 'legacy' } }, 'MODEL_SOURCE_NOT_MIGRATED']
  ] as const)('does not silently downgrade unsupported requests', (value, reason) => {
    expect(assessLegacyRunEligibility(value)).toEqual({ eligible: false, reason })
  })
  it('revalidates the projected managed model against the selected workspace', () => {
    const eligibility = assessLegacyRunEligibility({
      ...input,
      modelSource: { kind: 'ola-team', workspaceId: 'team-a', resourceId: 'model-a' }
    })
    expect(eligibility.eligible).toBe(true)
    if (!eligibility.eligible) return
    expect(() =>
      projectEligibleLegacyRun(eligibility, {
        runId: 'run',
        taskId: 'task',
        requestId: 'request',
        traceId: 'trace',
        sessionId: 'session',
        workspaceId: 'team-b',
        environmentId: 'local',
        unattended: false
      })
    ).toThrow('WORKSPACE_MISMATCH')
  })
})
