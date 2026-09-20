import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  values: new Map<string, string>(),
  writes: [] as Array<{ providerId: string; value: string }>
}))

vi.mock('../../src/main/providers/provider-secret-store', () => ({
  getProviderSecretStore: () => ({
    get: async (providerId: string) => state.values.get(providerId) ?? '',
    set: async (providerId: string, value: string) => {
      state.values.set(providerId, value)
      state.writes.push({ providerId, value })
      return { configured: true, suffix: value.slice(-4) }
    }
  })
}))

import {
  hydrateProviderMainMirror,
  listMainProviderModels,
  resolveMainProviderSecret
} from '../../src/main/providers/provider-main-store'

beforeEach(() => {
  state.values.clear()
  state.writes = []
  hydrateProviderMainMirror({
    'ola-providers': {
      providers: [
        {
          id: 'provider-a',
          name: 'Provider A',
          type: 'openai-chat',
          baseUrl: 'http://127.0.0.1',
          enabled: true,
          apiKey: 'legacy-secret',
          models: [{ id: 'model-a', enabled: true, type: 'openai-chat' }]
        }
      ]
    }
  })
})

it('migrates a legacy provider secret once and resolves only the encrypted copy', async () => {
  await expect(resolveMainProviderSecret('provider-a', 'legacy-secret')).resolves.toBe(
    'legacy-secret'
  )
  expect(state.writes).toEqual([{ providerId: 'provider-a', value: 'legacy-secret' }])

  await expect(resolveMainProviderSecret('provider-a', 'different-secret')).resolves.toBe(
    'legacy-secret'
  )
  expect(state.writes).toHaveLength(1)
})

it('uses the migrated Main secret gate when listing usable provider models', async () => {
  await expect(listMainProviderModels('openai-chat')).resolves.toEqual([
    { providerId: 'provider-a', providerName: 'Provider A', modelId: 'model-a' }
  ])
  expect(state.writes).toEqual([{ providerId: 'provider-a', value: 'legacy-secret' }])
})
