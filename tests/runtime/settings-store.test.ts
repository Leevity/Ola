import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SettingsStore } from '../../src/main/settings/settings-store'

describe('SettingsStore', () => {
  it('retries transient rename locks before committing the settings snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-settings-lock-'))
    const filePath = join(root, 'settings.json')
    let attempts = 0
    try {
      await writeFile(filePath, JSON.stringify({ existing: true }), 'utf8')
      const store = new SettingsStore(filePath, async (source, destination) => {
        attempts += 1
        if (attempts < 3) {
          const error = new Error('destination temporarily locked') as NodeJS.ErrnoException
          error.code = 'EPERM'
          throw error
        }
        await rename(source, destination)
      })
      await expect(store.set('next', 2)).resolves.toEqual({ success: true })
      expect(attempts).toBe(3)
      await expect(store.read()).resolves.toEqual({ existing: true, next: 2 })
      expect(await readdir(root)).toEqual(['settings.json'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves the previous settings and removes the temporary file after a permanent lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-settings-lock-'))
    const filePath = join(root, 'settings.json')
    let attempts = 0
    let locked = true
    try {
      await writeFile(filePath, JSON.stringify({ existing: true }), 'utf8')
      const store = new SettingsStore(filePath, async (source, destination) => {
        attempts += 1
        if (locked) {
          const error = new Error('destination remains locked') as NodeJS.ErrnoException
          error.code = 'EPERM'
          throw error
        }
        await rename(source, destination)
      })
      await expect(store.set('next', 2)).resolves.toMatchObject({ success: false })
      expect(attempts).toBe(8)
      await expect(store.read()).resolves.toEqual({ existing: true })
      expect(await readdir(root)).toEqual(['settings.json'])
      locked = false
      await expect(store.set('next', 2)).resolves.toEqual({ success: true })
      await expect(store.read()).resolves.toEqual({ existing: true, next: 2 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

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
      await expect(store.read()).rejects.toThrow('SETTINGS_INVALID_ROOT')
      await expect(store.set('three', 3)).resolves.toMatchObject({ success: false })
      await expect(readFile(filePath, 'utf8')).resolves.toBe('[]')
      await writeFile(filePath, '{broken', 'utf8')
      await expect(store.set('three', 3)).resolves.toMatchObject({ success: false })
      await expect(readFile(filePath, 'utf8')).resolves.toBe('{broken')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
