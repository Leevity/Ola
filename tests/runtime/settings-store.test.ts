import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SettingsStore } from '../../src/main/settings/settings-store'

describe('SettingsStore', () => {
  it('keeps the legacy root format and serializes updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-settings-store-'))
    const filePath = join(root, 'nested', 'settings.json')
    try {
      const store = new SettingsStore(filePath)
      await expect(
        Promise.all([store.set('one', 1), store.set('two', { value: true })])
      ).resolves.toEqual([{ success: true }, { success: true }])
      await expect(store.get('one')).resolves.toBe(1)
      await expect(store.set('one', null)).resolves.toEqual({ success: true })
      await expect(store.read()).resolves.toEqual({ two: { value: true } })
      await expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ two: { value: true } })
      await writeFile(filePath, '[]', 'utf8')
      await expect(store.read()).resolves.toEqual({})
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
