import { describe, expect, it } from 'vitest'
import {
  resolveWebSearchSecret,
  migrateLegacyWebSearchSecret,
  withMainOwnedWebSearchSecret
} from '../../src/main/web/web-search-secret-resolution'

function store(initial = ''): { get(): Promise<string>; set(value: unknown): Promise<void> } {
  let value = initial
  return {
    get: async () => value,
    set: async (next) => {
      value = String(next).trim()
    }
  }
}

describe('Main-owned web search secret resolution', () => {
  it('imports a legacy value only when no encrypted value exists', async () => {
    const secrets = store()
    await expect(resolveWebSearchSecret(secrets, ' legacy-key ')).resolves.toBe('legacy-key')
    await expect(resolveWebSearchSecret(secrets, 'renderer-replacement')).resolves.toBe(
      'legacy-key'
    )
  })

  it('replaces renderer credentials before forwarding an enabled Worker request', async () => {
    await expect(
      withMainOwnedWebSearchSecret(store('main-secret'), {
        provider: {},
        webSearch: { enabled: true, provider: 'tavily', apiKey: 'renderer-secret' }
      })
    ).resolves.toEqual({
      provider: {},
      webSearch: { enabled: true, provider: 'tavily', apiKey: 'main-secret' }
    })
  })

  it('does not add a key when search is disabled or no secret has been configured', async () => {
    const secrets = store()
    await expect(
      withMainOwnedWebSearchSecret(secrets, {
        webSearch: { enabled: false, provider: 'tavily', apiKey: 'renderer-secret' }
      })
    ).resolves.toEqual({
      webSearch: { enabled: false, provider: 'tavily', apiKey: 'renderer-secret' }
    })
    await expect(
      withMainOwnedWebSearchSecret(secrets, { webSearch: { enabled: true, provider: 'tavily' } })
    ).resolves.toEqual({ webSearch: { enabled: true, provider: 'tavily' } })
  })

  it('imports the persisted legacy key before deleting plaintext storage', async () => {
    const secrets = store()
    let legacyKey = 'legacy-key'
    let clearCalls = 0
    await migrateLegacyWebSearchSecret(secrets, {
      readLegacyApiKey: async () => legacyKey,
      clearLegacyApiKey: async () => {
        expect(await secrets.get()).toBe('legacy-key')
        clearCalls += 1
        legacyKey = ''
      }
    })
    await expect(secrets.get()).resolves.toBe('legacy-key')
    expect(legacyKey).toBe('')
    expect(clearCalls).toBe(1)
  })

  it('removes an old persisted key without replacing an existing Main secret', async () => {
    const secrets = store('main-key')
    let cleared = false
    await migrateLegacyWebSearchSecret(secrets, {
      readLegacyApiKey: async () => 'old-renderer-key',
      clearLegacyApiKey: async () => {
        cleared = true
      }
    })
    await expect(secrets.get()).resolves.toBe('main-key')
    expect(cleared).toBe(true)
  })
})
