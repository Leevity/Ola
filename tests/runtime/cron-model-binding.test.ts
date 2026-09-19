import { describe, expect, it } from 'vitest'
import { parseCronModelBinding } from '../../src/shared/runtime/cron-model-binding'

describe('Cron ModelSource binding', () => {
  it('accepts a local provider in every workspace', () => {
    expect(
      parseCronModelBinding(
        JSON.stringify({ kind: 'local', providerId: 'lan', modelId: 'qwen' }),
        'team-a'
      )
    ).toEqual({ kind: 'local', providerId: 'lan', modelId: 'qwen' })
  })

  it('requires hosted resources to remain in the job workspace', () => {
    expect(
      parseCronModelBinding(
        JSON.stringify({ kind: 'ola-team', workspaceId: 'team-a', resourceId: 'resource-a' }),
        'team-a'
      )
    ).toEqual({ kind: 'ola-team', workspaceId: 'team-a', resourceId: 'resource-a' })
    expect(() =>
      parseCronModelBinding(
        JSON.stringify({ kind: 'ola-team', workspaceId: 'team-b', resourceId: 'resource-a' }),
        'team-a'
      )
    ).toThrow('WORKSPACE_MISMATCH')
  })

  it('rejects malformed or secret-bearing data rather than falling back', () => {
    expect(() => parseCronModelBinding('{broken', 'local-personal')).toThrow('INVALID_MODEL_SOURCE')
    expect(() =>
      parseCronModelBinding(
        JSON.stringify({ kind: 'local', providerId: 'lan', modelId: 'qwen', apiKey: 'secret' }),
        'local-personal'
      )
    ).toThrow('INVALID_MODEL_SOURCE')
  })
})
