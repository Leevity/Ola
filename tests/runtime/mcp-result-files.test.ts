import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { materializeMcpArtifacts } from '../../src/main/mcp/mcp-result-files'
import type { ToolContext } from '../../src/runtime/tools/tool-executor'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ola-mcp-files-'))
  directories.push(root)
  const context = {
    run: { workingDirectory: root, runId: 'run' },
    toolCallId: 'call',
    signal: new AbortController().signal
  } as ToolContext
  const manager = { getTools: () => [], callTool: async () => null }
  return { root, context, manager }
}
describe('MCP file results', () => {
  it('materializes embedded documents and audio but never ordinary text blocks', async () => {
    const { root, context, manager } = await fixture()
    const artifacts = await materializeMcpArtifacts(
      {
        content: [
          { type: 'text', text: 'not a file' },
          {
            type: 'resource',
            resource: { uri: 'doc://report', mimeType: 'text/markdown', text: '# Report' }
          },
          { type: 'audio', mimeType: 'audio/wav', data: Buffer.from('audio').toString('base64') }
        ]
      },
      context,
      manager,
      'docs'
    )
    expect(artifacts).toHaveLength(2)
    expect(artifacts[0].path.startsWith(join(root, '.ola-results'))).toBe(true)
    expect(await readFile(artifacts[0].path, 'utf8')).toBe('# Report')
    expect(artifacts[1].mediaType).toBe('audio/wav')
  })
  it('indexes only existing local files within the approved execution directory', async () => {
    const { root, context, manager } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'ola-mcp-outside-'))
    directories.push(outside)
    await writeFile(join(root, 'report.txt'), 'report')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    const artifacts = await materializeMcpArtifacts(
      {
        content: [
          { type: 'resource_link', uri: pathToFileURL(join(root, 'report.txt')).href },
          { type: 'resource_link', uri: pathToFileURL(join(outside, 'secret.txt')).href },
          { type: 'resource_link', uri: 'invalid URL' }
        ]
      },
      context,
      manager,
      'docs'
    )
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].path).toBe(join(root, 'report.txt'))
  })
  it('reads server-owned resource links and excludes failed or malformed content', async () => {
    const { context, manager } = await fixture()
    const result = { content: [{ type: 'resource_link', uri: 'docs://report' }] }
    const artifacts = await materializeMcpArtifacts(
      result,
      context,
      {
        ...manager,
        readResource: async () => ({
          contents: [{ mimeType: 'application/json', text: '{"ok":true}' }]
        })
      },
      'docs'
    )
    expect(artifacts).toHaveLength(1)
    expect(
      await materializeMcpArtifacts({ isError: true, ...result }, context, manager, 'docs')
    ).toEqual([])
    expect(
      await materializeMcpArtifacts(
        { content: [{ type: 'audio', mimeType: 'audio/wav', data: 'invalid!' }] },
        context,
        manager,
        'docs'
      )
    ).toEqual([])
  })
})

it('stores embedded chat results in a host-managed directory when no working folder is selected', async () => {
  const { root, context, manager } = await fixture()
  context.run.workingDirectory = undefined
  const managed = join(root, 'workspace-cache')
  const artifacts = await materializeMcpArtifacts(
    {
      content: [
        { type: 'resource', resource: { text: 'Chat report', mimeType: 'text/plain' } },
        { type: 'resource_link', uri: pathToFileURL(join(root, 'private.txt')).href }
      ]
    },
    context,
    manager,
    'docs',
    managed
  )
  expect(artifacts).toHaveLength(1)
  expect(artifacts[0].path.startsWith(managed)).toBe(true)
})
