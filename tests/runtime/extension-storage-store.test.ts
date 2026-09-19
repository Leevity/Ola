import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExtensionStorageStore } from '../../src/main/extensions/extension-storage-store'

describe('extension storage store', () => {
  it('preserves the legacy JSON shape and serializes mutations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-extension-storage-'))
    const path = join(root, 'extensions-storage.json')
    try {
      await writeFile(path, JSON.stringify({ example: { old: true } }))
      const store = new ExtensionStorageStore(path)
      await Promise.all([
        store.set('Example', 'one', { value: 1 }),
        store.set('example', 'two', ['value'])
      ])
      await expect(store.get('example', 'old')).resolves.toBe(true)
      await expect(store.get('EXAMPLE', 'one')).resolves.toEqual({ value: 1 })
      await store.delete('example', 'old')
      await expect(store.get('example', 'old')).resolves.toBeNull()
      await expect(readFile(path, 'utf8')).resolves.toContain('"two"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
