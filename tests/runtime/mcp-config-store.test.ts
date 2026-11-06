import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { McpConfigStore } from '../../src/main/mcp/mcp-config-store'
import { deriveMcpToolAlias } from '../../src/shared/mcp-tool-policy'
import type { McpServerConfig } from '../../src/main/mcp/mcp-types'

const server = (id: string): McpServerConfig => ({
  id,
  name: id,
  enabled: true,
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
  createdAt: 1,
  toolAlias: id
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

  it('drops malformed records and backfills a legacy alias from the id, not the name', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-mcp-store-legacy-'))
    const filePath = join(directory, 'mcp-servers.json')
    const longId = 'srv_01J9ZK7M4QTXRVWBNCDEFGHIJK'
    try {
      await writeFile(
        filePath,
        JSON.stringify([
          { id: 'gone', name: 'No transport' },
          { id: '', name: 'No id' },
          { id: 'two', name: 'Two', transport: 'streamable-http', url: 'https://x.test/mcp' },
          { id: longId, name: 'Renamed later', transport: 'stdio', command: 'node' },
          'a string',
          { id: 'four', name: 'Four', transport: 'stdio', enabledTools: 'search', timeoutMs: -5 }
        ]),
        'utf8'
      )
      const list = await new McpConfigStore(filePath).list()
      expect(list.map((entry) => entry.id)).toEqual(['two', longId, 'four'])
      // Derived from the immutable id so editing `name` can never re-name the tool namespace.
      expect(list[1].toolAlias).toBe(deriveMcpToolAlias(longId))
      expect(list[1].toolAlias).not.toContain('renamed')
      expect(list[1].toolAlias).toMatch(/^[a-z][a-z0-9-]{0,11}$/)
      // A non-array allowlist is a malformed field, not a blanket filter.
      expect(list[2].enabledTools).toBeUndefined()
      expect(list[2].timeoutMs).toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('allocates distinct aliases at creation and refuses an exposure over the run budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-mcp-store-alias-'))
    const filePath = join(directory, 'mcp-servers.json')
    try {
      const store = new McpConfigStore(filePath)
      await store.add({ ...server('a'), name: 'REA' })
      await store.add({ ...server('b'), name: 'rea' })
      const list = await store.list()
      // Two servers labelled REA cannot share a namespace: the first keeps the readable alias and
      // the second falls back to a hash of its own immutable id.
      expect(list[0].toolAlias).toBe('rea')
      expect(list[1].toolAlias).toBe(deriveMcpToolAlias('b', 'rea', new Set(['rea'])))
      expect(list[1].toolAlias).toMatch(/^[a-z][a-z0-9-]{0,11}$/)
      expect(new Set(list.map((entry) => entry.toolAlias)).size).toBe(2)
      await expect(
        store.update('a', { activePreset: 'native', toolPresets: { native: ['x'] } })
      ).resolves.toEqual({ success: true })
      const oversized = Array.from({ length: 33 }, (_value, index) => `tool_${index}`)
      await expect(store.update('a', { enabledTools: oversized })).resolves.toMatchObject({
        success: false
      })
      // A rejected write must leave the stored entry untouched.
      await expect(store.get('a')).resolves.toEqual({
        server: {
          ...server('a'),
          toolAlias: 'rea',
          name: 'REA',
          activePreset: 'native',
          toolPresets: { native: ['x'] }
        }
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
