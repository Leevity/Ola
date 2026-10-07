import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createMcpRuntimeTools } from '../../src/main/mcp/mcp-runtime-tools'
import { ToolExecutor } from '../../src/runtime/tools/tool-executor'
import type { RunSpec } from '../../src/shared/runtime/contracts'

describe('MCP runtime tools', () => {
  it('journals explicit HTTP resource links and excludes unsafe or failed results', async () => {
    let failed = false
    const tools = createMcpRuntimeTools(
      {
        getTools: () => [{ name: 'report', inputSchema: {} }],
        callTool: async () => ({
          isError: failed,
          content: [
            { type: 'text', text: 'https://example.com/unverified' },
            { type: 'resource_link', name: 'Report', uri: 'https://example.com/report' },
            { type: 'resource_link', name: 'Duplicate', uri: 'https://example.com/report' },
            { type: 'resource_link', name: 'Local', uri: 'file:///C:/secret.txt' },
            { type: 'resource_link', name: 'Credentials', uri: 'https://token:secret@example.com' }
          ]
        })
      },
      ['docs']
    )
    const executor = new ToolExecutor(tools, async () => true)
    const events: Array<{ type: string; data: unknown }> = []
    const context = {
      run: { runId: 'mcp-run', workspaceId: 'team-a', unattended: false } as RunSpec,
      signal: new AbortController().signal
    }
    const record = async (type: string, data: unknown): Promise<void> => {
      events.push({ type, data })
    }
    const results = await executor.executeAll(
      [{ id: 'call-1', name: tools[0].name, input: {} }],
      context,
      record
    )
    expect(results[0].isError).not.toBe(true)
    expect(events.filter((event) => event.type === 'artifact.registered')).toEqual([
      {
        type: 'artifact.registered',
        data: {
          toolCallId: 'call-1',
          kind: 'link',
          transport: 'remote',
          url: 'https://example.com/report',
          title: 'Report'
        }
      }
    ])
    failed = true
    events.length = 0
    const failedResults = await executor.executeAll(
      [{ id: 'call-2', name: tools[0].name, input: {} }],
      context,
      record
    )
    expect(failedResults[0].isError).toBe(true)
    expect(events.filter((event) => event.type === 'artifact.registered')).toEqual([])
  })
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

it('indexes large audio as a file and keeps the model result within the frame limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ola-mcp-audio-'))
  try {
    const data = Buffer.alloc(200_000, 1)
    const [tool] = createMcpRuntimeTools(
      {
        getTools: () => [{ name: 'audio', inputSchema: {} }],
        callTool: async () => ({
          content: [{ type: 'audio', mimeType: 'audio/wav', data: data.toString('base64') }]
        })
      },
      ['media']
    )
    const context = {
      run: { runId: 'audio-run', workingDirectory: root } as RunSpec,
      signal: new AbortController().signal
    }
    const output = await tool.execute({}, context)
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(128 * 1024)
    const artifacts = await tool.artifacts!(output, context)
    expect(artifacts).toHaveLength(1)
    expect(await readFile((artifacts[0] as { path: string }).path)).toEqual(data)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
