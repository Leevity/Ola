import { afterEach, describe, expect, it, vi } from 'vitest'
import { toolRegistry } from '../../src/renderer/src/lib/agent/tool-registry'
import {
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
  it('executes dynamic MCP tools through the Main IPC bridge', async () => {
    const invoke = vi
      .spyOn(ipcClient, 'invoke')
      .mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    registerMcpTools(
      [{ id: 'docs', name: 'Docs', enabled: true, transport: 'stdio', createdAt: 1 }],
      { docs: [{ name: 'search', inputSchema: { type: 'object' } }] }
    )

    const handler = toolRegistry.get('mcp__docs__search')
    expect(handler).toBeDefined()
    await expect(
      handler!.execute({ query: 'runtime' }, { signal: new AbortController().signal } as never)
    ).resolves.toContain('ok')
    expect(invoke).toHaveBeenCalledWith(IPC.MCP_CALL_TOOL, {
      serverId: 'docs',
      toolName: 'search',
      args: { query: 'runtime' }
    })
  })

  it('reads dynamic MCP resources through the Main IPC bridge', async () => {
    const invoke = vi.spyOn(ipcClient, 'invoke').mockResolvedValue({ contents: [{ text: 'doc' }] })
    registerMcpResources(
      [{ id: 'docs', name: 'Docs', enabled: true, transport: 'stdio', createdAt: 1 }],
      { docs: [{ name: 'readme', uri: 'file://readme.md' }] }
    )

    const handler = toolRegistry.get('mcp__docs__resource__readme')
    expect(handler).toBeDefined()
    await handler!.execute({}, { signal: new AbortController().signal } as never)
    expect(invoke).toHaveBeenCalledWith(IPC.MCP_READ_RESOURCE, {
      serverId: 'docs',
      uri: 'file://readme.md',
      resourceName: 'readme'
    })
  })
})
