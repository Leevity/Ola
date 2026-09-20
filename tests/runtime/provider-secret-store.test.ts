import { describe, expect, it } from 'vitest'
import { ProviderSecretStore } from '../../src/main/providers/provider-secret-store'
import type { ExtensionSecretStore } from '../../src/main/extensions/extension-service'

function createBackend(): ExtensionSecretStore & { keys: string[] } {
  const values = new Map<string, string>()
  return {
    keys: [],
    async get(extensionId, key) {
      this.keys.push(`${extensionId}:${key}`)
      return values.get(`${extensionId}:${key}`) ?? ''
    },
    async set(extensionId, key, value) {
      this.keys.push(`${extensionId}:${key}`)
      values.set(`${extensionId}:${key}`, value)
    },
    async delete(extensionId, key) {
      this.keys.push(`${extensionId}:${key}`)
      values.delete(`${extensionId}:${key}`)
    }
  }
}

describe('provider secret store', () => {
  it('stores provider secrets behind a hashed vault identity', async () => {
    const backend = createBackend()
    const store = new ProviderSecretStore(backend)

    await expect(store.set('OpenAI:team-a', 'secret-value')).resolves.toMatchObject({
      configured: true,
      suffix: 'alue'
    })
    await expect(store.get('OpenAI:team-a')).resolves.toBe('secret-value')
    expect(backend.keys.every((key) => !key.includes('OpenAI:team-a'))).toBe(true)
  })

  it('does not expose a secret in status and removes it explicitly', async () => {
    const backend = createBackend()
    const store = new ProviderSecretStore(backend)
    await store.set('provider-one', 'very-secret')
    await expect(store.status('provider-one')).resolves.toEqual({
      configured: true,
      suffix: 'cret'
    })
    await store.delete('provider-one')
    await expect(store.status('provider-one')).resolves.toEqual({
      configured: false,
      suffix: null
    })
  })

  it('rejects empty or oversized values', async () => {
    const store = new ProviderSecretStore(createBackend())
    await expect(store.set('provider-one', '   ')).rejects.toThrow('Invalid provider secret')
    await expect(store.set('provider-one', 'x'.repeat(16 * 1024 + 1))).rejects.toThrow(
      'Invalid provider secret'
    )
  })
})
