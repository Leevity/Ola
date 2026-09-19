import { describe, expect, it } from 'vitest'
import { resolveManagedResourceTarget } from '../../src/main/runtime/managed-resource-resolver'

describe('managed runtime resource resolver', () => {
  it('accepts only an enabled resource with an allowlisted protocol', () => {
    expect(
      resolveManagedResourceTarget({
        workspaceId: 'team-a',
        resourceId: 'r',
        resources: [{ id: 'r', model: 'gpt', enabled: true, protocol: 'openai-responses' }]
      })
    ).toEqual({
      workspaceId: 'team-a',
      resourceId: 'r',
      model: 'gpt',
      protocol: 'openai-responses'
    })
  })
  it.each([
    [[{ id: 'r', model: 'gpt', enabled: false, protocol: 'openai-chat' }]],
    [[{ id: 'r', model: 'gpt', enabled: true, protocol: 'unknown' }]],
    [[{ id: 'other', model: 'gpt', enabled: true, protocol: 'openai-chat' }]]
  ])('rejects unavailable resources', (resources) => {
    expect(() =>
      resolveManagedResourceTarget({ workspaceId: 'team-a', resourceId: 'r', resources })
    ).toThrow('MODEL_UNAVAILABLE')
  })
})
