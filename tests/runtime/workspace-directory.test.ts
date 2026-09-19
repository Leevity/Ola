import { describe, expect, it } from 'vitest'
import { publicModelDirectory } from '../../src/shared/workspace-directory'

describe('public managed model directory', () => {
  it('keeps only allowlisted public resource fields and protocols', () => {
    expect(
      publicModelDirectory({
        resources: [
          {
            id: 'resource-a',
            model: 'gpt-test',
            protocol: 'openai-responses',
            enabled: true,
            apiKey: 'must-not-cross-boundary',
            accessToken: 'must-not-cross-boundary'
          },
          { id: 'resource-b', model: 'unknown', protocol: 'future-private-protocol' }
        ]
      })
    ).toEqual({
      resources: [
        expect.objectContaining({
          id: 'resource-a',
          model: 'gpt-test',
          protocol: 'openai-responses',
          enabled: true
        }),
        expect.objectContaining({ id: 'resource-b', model: 'unknown' })
      ]
    })
    const resources = publicModelDirectory({
      resources: [{ id: 'resource-a', model: 'gpt-test', apiKey: 'secret' }]
    }).resources
    expect(resources[0]).not.toHaveProperty('apiKey')
    expect(resources[0]).not.toHaveProperty('accessToken')
  })
})
