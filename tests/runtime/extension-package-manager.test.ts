import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExtensionPackageManager } from '../../src/main/extensions/extension-package-manager'
import type { ExtensionSecretStore } from '../../src/main/extensions/extension-service'
import { ExtensionStateStore } from '../../src/main/extensions/extension-state-store'
import { ExtensionStorageStore } from '../../src/main/extensions/extension-storage-store'

const secrets: ExtensionSecretStore = {
  get: async () => '',
  set: async () => {},
  delete: async () => {}
}

async function extension(directory: string, id: string, version = '1'): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: id,
      version,
      tools: [{ name: 'run', kind: 'http', http: { url: 'https://example.com' } }]
    })
  )
  await writeFile(join(directory, 'index.txt'), version)
}

describe('extension package manager', () => {
  it('installs atomically, preserves state during bundled upgrades, and removes all state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-extension-package-'))
    const source = join(root, 'source')
    const bundled = join(root, 'bundled')
    const extensions = join(root, 'extensions')
    const states = new ExtensionStateStore(join(root, 'extensions.json'))
    const storage = new ExtensionStorageStore(join(root, 'extensions-storage.json'))
    const manager = new ExtensionPackageManager(extensions, states, storage, secrets)
    try {
      await extension(source, 'custom')
      await expect(manager.installFromFolder(source)).resolves.toBe('custom')
      await expect(manager.installFromFolder(source)).rejects.toThrow('already exists')
      await storage.set('custom', 'value', 1)
      await extension(join(bundled, 'custom'), 'custom', '2')
      await manager.ensureBundled([join(root, 'missing-bundled-dir'), bundled])
      await expect(states.get('custom')).resolves.toMatchObject({ enabled: false })
      await expect(readFile(join(extensions, 'custom', 'index.txt'), 'utf8')).resolves.toBe('2')
      await manager.remove('custom')
      await expect(storage.get('custom', 'value')).resolves.toBeNull()
      await expect(states.get('custom')).resolves.toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
