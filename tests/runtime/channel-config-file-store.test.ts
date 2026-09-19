import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChannelConfigFileStore } from '../../src/main/channels/channel-config-file-store'
import type { ChannelInstance } from '../../src/main/channels/channel-types'

const plugin = (id: string): ChannelInstance =>
  ({ id, type: 'webhook', name: id, enabled: true, config: {} }) as ChannelInstance

describe('ChannelConfigFileStore', () => {
  it('keeps the legacy array format and returns only exact plugin ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-channel-config-'))
    const filePath = join(root, 'nested', 'plugins.json')
    try {
      const store = new ChannelConfigFileStore(filePath)
      await expect(store.write([plugin('first'), plugin('second')])).resolves.toEqual({
        success: true
      })
      await expect(store.get('second')).resolves.toMatchObject({ id: 'second' })
      await expect(store.get('missing')).resolves.toBeNull()
      await expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual([
        plugin('first'),
        plugin('second')
      ])
      await writeFile(filePath, '{}', 'utf8')
      await expect(store.list()).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
