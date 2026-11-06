import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createMcpRuntimeTools } from '../../src/main/mcp/mcp-runtime-tools'
import type { McpRuntimeManager } from '../../src/main/mcp/mcp-runtime-tools'
import { ToolExecutor } from '../../src/runtime/tools/tool-executor'
import type { ExposedMcpTool, McpOutputLimits } from '../../src/main/mcp/mcp-types'
import type { RunSpec } from '../../src/shared/runtime/contracts'
import { buildExposedMcpTools } from '../../src/shared/mcp-tool-policy'

type AdvertisedTool = { name: string; description?: string; inputSchema?: Record<string, unknown> }

function exposed(alias: string, tools: AdvertisedTool[]): ExposedMcpTool[] {
  return buildExposedMcpTools(alias, tools).exposed
}

function managerFor(
  tools: AdvertisedTool[],
  callTool: McpRuntimeManager['callTool'],
  alias = 'docs',
  outputLimits?: McpOutputLimits
): McpRuntimeManager {
  return {
    getTools: (serverId) => exposed(serverId === 'srv' ? 'srv' : alias, tools),
    callTool,
    getToolAlias: (serverId) => (serverId === 'srv' ? 'srv' : alias),
    getOutputLimits: () => outputLimits
  }
}

describe('MCP runtime tools', () => {
  it('journals explicit HTTP resource links and excludes unsafe or failed results', async () => {
    let failed = false
    const tools = createMcpRuntimeTools(
      managerFor([{ name: 'report', inputSchema: {} }], async () => ({
        isError: failed,
        content: [
          { type: 'text', text: 'https://example.com/unverified' },
          { type: 'resource_link', name: 'Report', uri: 'https://example.com/report' },
          { type: 'resource_link', name: 'Duplicate', uri: 'https://example.com/report' },
          { type: 'resource_link', name: 'Local', uri: 'file:///C:/secret.txt' },
          { type: 'resource_link', name: 'Credentials', uri: 'https://token:secret@example.com' }
        ]
      })),
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
  it('registers under the alias the renderer derives and calls Main with the advertised name', async () => {
    const calls: Array<{ serverId: string; name: string; input: Record<string, unknown> }> = []
    const tools = createMcpRuntimeTools(
      {
        getTools: (serverId) =>
          serverId === 'docs'
            ? exposed('docs', [
                {
                  name: 'search',
                  description: 'Search documentation.',
                  inputSchema: { type: 'object', properties: { query: { type: 'string' } } }
                }
              ])
            : [],
        callTool: async (serverId, name, input) => {
          calls.push({ serverId, name, input })
          return { content: [{ type: 'text', text: 'result' }] }
        },
        getToolAlias: () => 'docs'
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

  it('refuses to register a tool whose alias is not a legal namespace', () => {
    // Alias legality is decided in Main, where the tool is reported as unexposable with a
    // diagnostic. Reaching the registry with an unusable alias is a bug, and inventing a
    // sanitized name here would silently diverge from the name the renderer shows.
    const tools = createMcpRuntimeTools(
      managerFor([{ name: 'safe' }, { name: 'not safe' }], async () => ({}), 'unsafe server'),
      ['docs']
    )
    expect(tools).toEqual([])
  })

  it('registers one tool when advertised names collide on the same external segment', () => {
    const tools = createMcpRuntimeTools(
      managerFor([{ name: 'a.b' }, { name: 'a_b' }, { name: '   ' }], async () => ({}), 'srv'),
      ['srv']
    )
    expect(tools.map((tool) => tool.name)).toEqual(['mcp__srv__a_b'])
  })

  it('bounds tool inputs', () => {
    const tool = createMcpRuntimeTools(
      managerFor([{ name: 'safe' }], async () => ({})),
      ['docs']
    )[0]
    expect(() => tool.validate({ payload: 'x'.repeat(64 * 1024) })).toThrow('INVALID_TOOL_INPUT')
  })

  it('registers server resources as read tools under the renderer naming convention', async () => {
    const reads: Array<{ serverId: string; uri: string }> = []
    const tools = createMcpRuntimeTools(
      {
        getTools: () => exposed('docs', [{ name: 'search' }]),
        callTool: async () => ({ content: [] }),
        getToolAlias: () => 'docs',
        getResources: () => [
          { uri: 'file:///notes/index', name: 'notes/index', mimeType: 'text/markdown' },
          { uri: '  ', name: 'has-no-uri' },
          { uri: 'ok://body', name: '   ' }
        ],
        readResource: async (serverId, uri) => {
          reads.push({ serverId, uri })
          return { contents: [{ uri, mimeType: 'text/markdown', text: '# note' }] }
        }
      },
      ['docs']
    )
    // One resource survives the unusable entries, and its name is the string the renderer derives
    // from `resource__<name>` — `/` is not a legal name character, so the segment is sanitized.
    expect(tools.map((tool) => tool.name)).toEqual([
      'mcp__docs__search',
      'mcp__docs__resource__notes_index'
    ])
    const resource = tools[1]
    expect(resource.effect).toBe('read')
    expect(resource.inputSchema).toEqual({ type: 'object', properties: {} })
    await expect(resource.resources({}, {} as never)).resolves.toEqual([
      'mcp:docs:file:///notes/index'
    ])
    expect(resource.validate({ ignored: true })).toEqual({})
    await expect(
      resource.execute({ ignored: true }, { signal: new AbortController().signal } as never)
    ).resolves.toEqual({
      contents: [{ uri: 'file:///notes/index', mimeType: 'text/markdown', text: '# note' }]
    })
    expect(reads).toEqual([{ serverId: 'docs', uri: 'file:///notes/index' }])
  })

  it('registers no resource tool when Main cannot read resources', () => {
    const tools = createMcpRuntimeTools(
      {
        getTools: () => exposed('docs', [{ name: 'search' }]),
        callTool: async () => ({ content: [] }),
        getToolAlias: () => 'docs',
        getResources: () => [{ uri: 'file:///notes/index', name: 'notes/index' }]
      },
      ['docs']
    )
    expect(tools.map((tool) => tool.name)).toEqual(['mcp__docs__search'])
  })

  it('keeps one name when a tool and a resource collide in the alias namespace', () => {
    const tools = createMcpRuntimeTools(
      {
        getTools: () => exposed('docs', [{ name: 'resource__spec' }]),
        callTool: async () => ({ content: [] }),
        getToolAlias: () => 'docs',
        getResources: () => [{ uri: 'file:///spec', name: 'spec' }],
        readResource: async () => ({ contents: [] })
      },
      ['docs']
    )
    expect(tools.map((tool) => tool.name)).toEqual(['mcp__docs__resource__spec'])
    expect(tools[0].effect).toBe('write')
  })
})

describe('MCP result sizing', () => {
  it('spills oversized text into the managed directory instead of failing the call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-mcp-spill-'))
    try {
      const text = 'x'.repeat(400 * 1024)
      const tool = createMcpRuntimeTools(
        managerFor([{ name: 'decompile' }], async () => ({ content: [{ type: 'text', text }] })),
        ['docs'],
        () => join(root, '.ola-results', 'mcp')
      )[0]
      const context = {
        run: { runId: 'spill-run', workingDirectory: root } as RunSpec,
        signal: new AbortController().signal
      }
      const output = (await tool.execute({}, context)) as { content: [{ text: string }] }
      const inline = JSON.stringify(output)
      expect(inline.length).toBeLessThan(1000)
      expect(inline).toContain(join('.ola-results', 'mcp'))
      const spilled = inline.match(/written to (\S+) —/)
      expect(spilled).not.toBeNull()
      expect(await readFile(spilled![1], 'utf8')).toBe(text)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('truncates oversized text with no managed directory and still fits the frame limit', async () => {
    const text = '月'.repeat(60 * 1024)
    const tool = createMcpRuntimeTools(
      managerFor([{ name: 'decompile' }], async () => ({ content: [{ type: 'text', text }] })),
      ['docs']
    )[0]
    const context = {
      run: { runId: 'truncate-run' } as RunSpec,
      signal: new AbortController().signal
    }
    const output = (await tool.execute({}, context)) as { content: [{ text: string }] }
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(128 * 1024)
    expect(output.content[0].text).toContain('no managed result directory')
    // A byte-budgeted cut must not leave half a code point behind.
    expect(output.content[0].text).not.toContain('\uFFFD')
  })

  it('keeps the hard ceiling when the oversized part is not reducible text', async () => {
    const tool = createMcpRuntimeTools(
      managerFor(
        [{ name: 'decompile' }],
        async () => ({
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: { blob: 'x'.repeat(300 * 1024) }
        }),
        'docs',
        { inlineTextBytes: 4096, maxResultBytes: 64 * 1024 }
      ),
      ['docs']
    )[0]
    const context = {
      run: { runId: 'ceiling-run' } as RunSpec,
      signal: new AbortController().signal
    }
    await expect(tool.execute({}, context)).rejects.toThrow('TOOL_OUTPUT_TOO_LARGE')
  })
})

it('indexes large audio as a file and keeps the model result within the frame limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ola-mcp-audio-'))
  try {
    const data = Buffer.alloc(200_000, 1)
    const [tool] = createMcpRuntimeTools(
      managerFor([{ name: 'audio' }], async () => ({
        content: [{ type: 'audio', mimeType: 'audio/wav', data: data.toString('base64') }]
      })),
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
