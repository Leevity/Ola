import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExtensionStateStore } from '../../src/main/extensions/extension-state-store'

describe('extension state store', () => {
  it('preserves legacy state, serializes updates, and removes stale extensions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-extension-state-'))
    const path = join(root, 'extensions.json')
    let clock = 100
    try {
      await writeFile(
        path,
        JSON.stringify({
          legacy: { enabled: true, installedAt: 1, updatedAt: 2, config: { endpoint: 'https://a' } }
        })
      )
      const store = new ExtensionStateStore(path, () => ++clock)
      await expect(store.get('LEGACY')).resolves.toMatchObject({
        enabled: true,
        config: { endpoint: 'https://a' }
      })
      await Promise.all([
        store.update('legacy', { enabled: false }),
        store.update('example', { config: { colour: 'blue' } })
      ])
      await expect(store.get('legacy')).resolves.toMatchObject({
        enabled: false,
        config: { endpoint: 'https://a' }
      })
      await expect(store.get('example')).resolves.toMatchObject({
        enabled: false,
        config: { colour: 'blue' }
      })
      await store.retain(['example'])
      await expect(store.get('legacy')).resolves.toBeNull()
      await expect(readFile(path, 'utf8')).resolves.toContain('"example"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
