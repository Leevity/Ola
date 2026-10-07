import { describe, expect, it } from 'vitest'
import {
  hydrateProviderCredentials,
  splitProviderCredentials
} from '../../src/main/providers/provider-auth-persistence'

describe('provider authentication persistence projection', () => {
  it('keeps tokens out of the public provider bucket and restores all credential shapes', () => {
    const original = {
      state: {
        providers: [
          {
            id: 'codex',
            name: 'Codex',
            apiKey: 'active-secret',
            authMode: 'oauth',
            oauth: { accessToken: 'active-secret', refreshToken: 'refresh-secret' },
            channel: { appId: 'app', appToken: 'channel-secret' },
            activeAccountId: 'account-one',
            oauthAccounts: [
              {
                id: 'account-one',
                email: 'owner@example.invalid',
                oauth: { accessToken: 'account-secret' }
              }
            ],
            models: [{ id: 'model-one' }]
          }
        ],
        activeProviderId: 'codex'
      },
      version: 1
    }
    const snapshot = JSON.stringify(original)
    const { publicState, credentials } = splitProviderCredentials(original)
    const publicJson = JSON.stringify(publicState)
    for (const token of ['active-secret', 'refresh-secret', 'channel-secret', 'account-secret']) {
      expect(publicJson).not.toContain(token)
    }
    expect(JSON.stringify(original)).toBe(snapshot)
    expect(hydrateProviderCredentials(publicState, credentials)).toEqual(original)
  })

  it('does not resurrect a removed account or top-level token from an older vault snapshot', () => {
    const previous = splitProviderCredentials({
      state: {
        providers: [
          {
            id: 'codex',
            apiKey: 'old-secret',
            oauth: { accessToken: 'old-secret' },
            oauthAccounts: [{ id: 'removed', oauth: { accessToken: 'old-secret' } }]
          }
        ]
      }
    })
    const current = splitProviderCredentials({
      state: { providers: [{ id: 'codex', apiKey: '', oauthAccounts: [] }] }
    })
    expect(hydrateProviderCredentials(current.publicState, previous.credentials)).toEqual(
      current.publicState
    )
  })

  it('passes through malformed or absent provider buckets without mutation', () => {
    expect(splitProviderCredentials(null)).toEqual({ publicState: null, credentials: {} })
    const noProviders = { state: { keep: true }, version: 1 }
    expect(splitProviderCredentials(noProviders).publicState).toBe(noProviders)
    expect(hydrateProviderCredentials(noProviders, {})).toBe(noProviders)
  })

  it('fails closed when public metadata references a missing credential bundle', () => {
    const publicState = splitProviderCredentials({
      state: {
        providers: [
          {
            id: 'codex',
            apiKey: 'secret',
            oauthAccounts: [{ id: 'one', oauth: { accessToken: 'secret' } }]
          }
        ]
      }
    }).publicState
    expect(() => hydrateProviderCredentials(publicState, {})).toThrow(
      'Provider credential bundle is missing'
    )
  })
})
