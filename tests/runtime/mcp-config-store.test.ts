import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { McpConfigStore } from '../../src/main/mcp/mcp-config-store'
import type { McpServerConfig } from '../../src/main/mcp/mcp-types'

const server = (id: string): McpServerConfig => ({
  id,
  name: id,
  enabled: true,
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
  createdAt: 1
})

describe('McpConfigStore', () => {
  it('keeps the existing JSON format and serializes mutations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-mcp-store-'))
    const filePath = join(directory, 'nested', 'mcp-servers.json')
    try {
      const store = new McpConfigStore(filePath)
      await expect(store.list()).resolves.toEqual([])
      await expect(
        Promise.all([store.add(server('one')), store.add(server('two'))])
      ).resolves.toEqual([{ success: true }, { success: true }])
      await expect(store.get('one')).resolves.toEqual({ server: server('one') })
      await expect(
        store.update('one', { enabled: false, description: 'updated' })
      ).resolves.toEqual({
        success: true
      })
      await expect(store.list()).resolves.toEqual([
        { ...server('one'), enabled: false, description: 'updated' },
        server('two')
      ])
      await expect(store.remove('missing')).resolves.toEqual({ success: true })
      await expect(store.remove('two')).resolves.toEqual({ success: true })
      await expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual([
        { ...server('one'), enabled: false, description: 'updated' }
      ])
      await writeFile(filePath, '{ invalid', 'utf8')
      await expect(store.list()).resolves.toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
