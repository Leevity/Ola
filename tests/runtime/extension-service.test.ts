import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ExtensionSecretStore } from '../../src/main/extensions/extension-service'
import { ExtensionService } from '../../src/main/extensions/extension-service'
import { ExtensionStateStore } from '../../src/main/extensions/extension-state-store'

class MemorySecrets implements ExtensionSecretStore {
  readonly values = new Map<string, string>()
  async get(extensionId: string, key: string): Promise<string> {
    return this.values.get(extensionId + ':' + key) ?? ''
  }
  async set(extensionId: string, key: string, value: string): Promise<void> {
    this.values.set(extensionId + ':' + key, value)
  }
  async delete(extensionId: string, key: string): Promise<void> {
    this.values.delete(extensionId + ':' + key)
  }
}

describe('extension service', () => {
  it('returns redacted snapshots while retaining secret values for runtime calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-extension-service-'))
    const extensions = join(root, 'extensions')
    try {
      await mkdir(join(extensions, 'sample'), { recursive: true })
      await writeFile(
        join(extensions, 'sample', 'extension.json'),
        JSON.stringify({
          schemaVersion: 1,
          id: 'sample',
          name: 'Sample',
          version: '1',
          configSchema: [
            { key: 'endpoint', type: 'text', defaultValue: 'https://default' },
            { key: 'token', type: 'secret' }
          ],
          tools: [{ name: 'lookup', kind: 'http', http: { url: 'https://example.com' } }]
        })
      )
      const secrets = new MemorySecrets()
      const service = new ExtensionService(
        extensions,
        new ExtensionStateStore(join(root, 'extensions.json')),
        secrets
      )
      await service.update('sample', {
        enabled: true,
        config: { endpoint: 'https://configured', token: 'do-not-leak' }
      })
      await expect(service.list()).resolves.toMatchObject([
        { id: 'sample', enabled: true, config: { endpoint: 'https://configured', token: '' } }
      ])
      await expect(service.getRuntime('sample')).resolves.toMatchObject({
        config: { endpoint: 'https://configured', token: 'do-not-leak' }
      })
      await service.update('sample', { config: { token: '' } })
      await expect(service.getRuntime('sample')).resolves.toMatchObject({
        config: { token: 'do-not-leak' }
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
