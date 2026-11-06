import { afterEach, describe, expect, it, vi } from 'vitest'
import { toolRegistry } from '../../src/renderer/src/lib/agent/tool-registry'
import {
  parseMcpToolName,
  registerMcpResources,
  registerMcpTools,
  unregisterMcpTools
} from '../../src/renderer/src/lib/mcp/mcp-tools'
import { ipcClient } from '../../src/renderer/src/lib/ipc/ipc-client'
import { IPC } from '../../src/renderer/src/lib/ipc/channels'

afterEach(() => {
  unregisterMcpTools()
  vi.restoreAllMocks()
})

describe('renderer MCP bridge', () => {
  it('registers exposed tools verbatim under Main-assigned external names', async () => {
    const invoke = vi
      .spyOn(ipcClient, 'invoke')
      .mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    registerMcpTools(
      [{ id: 'server-1', name: 'Docs', enabled: true, transport: 'stdio', createdAt: 1 }],
      {
        'server-1': [
          {
            name: 'search',
            alias: 'docs',
            externalName: 'mcp__docs__search',
            inputSchema: { type: 'object' }
          }
        ]
      }
    )

    const handler = toolRegistry.get('mcp__docs__search')
    expect(handler).toBeDefined()
    await expect(
      handler!.execute({ query: 'runtime' }, { signal: new AbortController().signal } as never)
    ).resolves.toContain('ok')
    // Calls route by the server-advertised name, not the external name.
    expect(invoke).toHaveBeenCalledWith(IPC.MCP_CALL_TOOL, {
      serverId: 'server-1',
      toolName: 'search',
      args: { query: 'runtime' }
    })
  })

  it('never registers tools Main left unnamed', () => {
    registerMcpTools(
      [{ id: 'server-1', name: 'Docs', enabled: true, transport: 'stdio', createdAt: 1 }],
      {
        'server-1': [
          { name: 'filtered', alias: 'docs', filtered: true },
          { name: 'broken', alias: 'docs', reason: 'TOO_LONG' }
        ]
      }
    )
    expect(getMcpNames()).not.toContain('mcp__docs__filtered')
    expect(toolRegistry.get('mcp__docs__broken')).toBeUndefined()
    expect(toolRegistry.get('mcp__server-1__filtered')).toBeUndefined()
  })

  it('reads dynamic MCP resources through the Main IPC bridge', async () => {
    const invoke = vi.spyOn(ipcClient, 'invoke').mockResolvedValue({ contents: [{ text: 'doc' }] })
    registerMcpResources(
      [
        {
          id: 'server-1',
          name: 'Docs',
          enabled: true,
          transport: 'stdio',
          toolAlias: 'docs',
          createdAt: 1
        }
      ],
      { 'server-1': [{ name: 'readme', uri: 'file://readme.md' }] }
    )

    const handler = toolRegistry.get('mcp__docs__resource__readme')
    expect(handler).toBeDefined()
    await handler!.execute({}, { signal: new AbortController().signal } as never)
    expect(invoke).toHaveBeenCalledWith(IPC.MCP_READ_RESOURCE, {
      serverId: 'server-1',
      uri: 'file://readme.md',
      resourceName: 'readme'
    })
  })

  it('parses canonical and legacy external names', () => {
    expect(parseMcpToolName('mcp__docs__search')).toEqual({ serverId: 'docs', toolName: 'search' })
    expect(parseMcpToolName('mcp__docs__resource__readme')).toEqual({
      serverId: 'docs',
      toolName: 'resource__readme'
    })
    const legacyId = 'V1StGXR8_Z5jdHi6B-myT'
    expect(parseMcpToolName(`mcp__${legacyId}__search`)).toEqual({
      serverId: legacyId,
      toolName: 'search'
    })
    expect(parseMcpToolName('Read')).toBeNull()
  })

  it('unregisters everything it registered, per owning server', () => {
    registerMcpTools(
      [{ id: 'server-1', name: 'Docs', enabled: true, transport: 'stdio', createdAt: 1 }],
      {
        'server-1': [{ name: 'search', alias: 'docs', externalName: 'mcp__docs__search' }]
      }
    )
    expect(toolRegistry.get('mcp__docs__search')).toBeDefined()
    unregisterMcpTools()
    expect(toolRegistry.get('mcp__docs__search')).toBeUndefined()
  })
})

function getMcpNames(): string[] {
  return toolRegistry
    .getStableDefinitions()
    .map((definition) => definition.name)
    .filter((name) => name.startsWith('mcp__'))
}
