import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigStore } from '../../src/main/config/config-store'

describe('ConfigStore', () => {
  it('preserves the legacy root format and serializes independent mutations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-config-store-'))
    const filePath = join(root, 'nested', 'config.json')
    try {
      const store = new ConfigStore(filePath)
      await expect(
        Promise.all([store.set('one', 1), store.set('two', { ok: true })])
      ).resolves.toEqual([{ success: true }, { success: true }])
      await expect(store.get('one')).resolves.toBe(1)
      await expect(store.get('missing')).resolves.toBeNull()
      await expect(store.delete('one')).resolves.toEqual({ success: true })
      await expect(store.write({ replacement: ['value'] })).resolves.toEqual({ success: true })
      expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
        replacement: ['value']
      })
      await writeFile(filePath, '[]', 'utf8')
      await expect(store.read()).resolves.toEqual({})
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
