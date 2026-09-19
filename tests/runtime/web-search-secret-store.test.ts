import { describe, expect, it } from 'vitest'
import { WebSearchSecretStore } from '../../src/main/web/web-search-secret-store'

class MemorySecrets {
  readonly values = new Map<string, string>()
  async get(id: string, key: string): Promise<string> {
    return this.values.get(`${id}:${key}`) ?? ''
  }
  async set(id: string, key: string, value: string): Promise<void> {
    this.values.set(`${id}:${key}`, value)
  }
  async delete(id: string, key: string): Promise<void> {
    this.values.delete(`${id}:${key}`)
  }
}

describe('web search secret store', () => {
  it('returns public configuration status without returning the stored key', async () => {
    const backend = new MemorySecrets()
    const store = new WebSearchSecretStore(backend)
    await expect(store.status()).resolves.toEqual({ configured: false, suffix: null })
    await expect(store.set('  search-secret-1234  ')).resolves.toEqual({
      configured: true,
      suffix: '1234'
    })
    await expect(store.get()).resolves.toBe('search-secret-1234')
    await expect(store.delete()).resolves.toEqual({ configured: false, suffix: null })
    await expect(store.get()).resolves.toBe('')
  })

  it('rejects empty and oversized secret input', async () => {
    const store = new WebSearchSecretStore(new MemorySecrets())
    await expect(store.set('')).rejects.toThrow('Invalid web search API key')
    await expect(store.set('x'.repeat(4_097))).rejects.toThrow('Invalid web search API key')
  })
})
