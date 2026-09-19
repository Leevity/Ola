import { describe, expect, it } from 'vitest'
import { createMcpRuntimeTools } from '../../src/main/mcp/mcp-runtime-tools'

describe('MCP runtime tools', () => {
  it('snapshots connected Main-owned tools with approval-required resources', async () => {
    const calls: Array<{ serverId: string; name: string; input: Record<string, unknown> }> = []
    const tools = createMcpRuntimeTools(
      {
        getTools: (serverId) =>
          serverId === 'docs'
            ? [
                {
                  name: 'search',
                  description: 'Search documentation.',
                  inputSchema: { type: 'object', properties: { query: { type: 'string' } } }
                }
              ]
            : [],
        callTool: async (serverId, name, input) => {
          calls.push({ serverId, name, input })
          return { content: [{ type: 'text', text: 'result' }] }
        }
      },
      ['docs', 'docs', 'missing']
    )
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ name: 'mcp__docs__search', effect: 'write' })
    await expect(tools[0].resources({}, {} as never)).resolves.toEqual(['mcp:docs:search'])
    await expect(
      tools[0].execute({ query: 'runtime' }, { signal: new AbortController().signal } as never)
    ).resolves.toEqual({ content: [{ type: 'text', text: 'result' }] })
    expect(calls).toEqual([{ serverId: 'docs', name: 'search', input: { query: 'runtime' } }])
  })

  it('skips unsafe server or tool identifiers and bounds tool inputs', () => {
    const tools = createMcpRuntimeTools(
      {
        getTools: () => [
          { name: 'safe', inputSchema: {} },
          { name: 'not safe', inputSchema: {} }
        ],
        callTool: async () => ({})
      },
      ['unsafe server']
    )
    expect(tools).toEqual([])
    const safe = createMcpRuntimeTools(
      { getTools: () => [{ name: 'safe', inputSchema: {} }], callTool: async () => ({}) },
      ['server']
    )[0]
    expect(() => safe.validate({ payload: 'x'.repeat(64 * 1024) })).toThrow('INVALID_TOOL_INPUT')
  })
})
