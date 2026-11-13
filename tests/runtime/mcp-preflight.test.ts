import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  isBlockingPreflightFailure,
  resolveCommandOnPath,
  runMcpPreflight
} from '../../src/main/mcp/mcp-preflight'
import { REA_MCP_NODE_RANGE } from '../../src/shared/rea-mcp-recipe'
import type { McpServerConfig } from '../../src/main/mcp/mcp-types'

let binDir = ''

function stdioConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'rea-server',
    name: 'Rea',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    createdAt: 0,
    toolAlias: 'rea',
    ...overrides
  }
}

beforeAll(async () => {
  binDir = await mkdtemp(join(tmpdir(), 'ola-mcp-preflight-'))
  // `existsSync` is the only check a PATH walk can make without executing anything.
  await writeFile(join(binDir, 'node'), '#!/bin/sh\n', { mode: 0o755 })
  await writeFile(join(binDir, 'node.EXE'), '', { mode: 0o755 })
  await writeFile(join(binDir, 'adb'), '#!/bin/sh\n', { mode: 0o755 })
})

describe('mcp preflight', () => {
  it('passes nothing when the server declares no gates', async () => {
    const env = { PATH: binDir }
    expect(await runMcpPreflight(stdioConfig(), { env })).toBeUndefined()
  })

  it('refuses a Node outside the declared range and names the version it saw', async () => {
    const diagnostic = await runMcpPreflight(
      stdioConfig({ preflight: { nodeCommand: 'node', nodeRange: REA_MCP_NODE_RANGE } }),
      { env: { PATH: binDir }, probe: async () => 'v25.6.1' }
    )
    expect(diagnostic?.code).toBe('NODE_VERSION_UNSUPPORTED')
    expect(diagnostic?.detail).toContain('25.6.1')
    expect(diagnostic?.hint).toContain(REA_MCP_NODE_RANGE)
    expect(isBlockingPreflightFailure(diagnostic)).toBe(true)
  })

  it('accepts a Node inside the range', async () => {
    const diagnostic = await runMcpPreflight(
      stdioConfig({ preflight: { nodeCommand: 'node', nodeRange: REA_MCP_NODE_RANGE } }),
      { env: { PATH: binDir }, probe: async () => 'v24.22.1' }
    )
    expect(diagnostic).toBeUndefined()
  })

  it('fails open when the probe output cannot be read', async () => {
    // An unknown answer must not be reported as a negative one: a shell alias, a banner on
    // stdout, or a launcher that ignores `-p` would otherwise strand a working server.
    for (const output of ['', 'not a version', undefined]) {
      const diagnostic = await runMcpPreflight(
        stdioConfig({ preflight: { nodeCommand: 'node', nodeRange: REA_MCP_NODE_RANGE } }),
        { env: { PATH: binDir }, probe: async () => output }
      )
      expect(diagnostic).toBeUndefined()
    }
  })

  it('reports a missing interpreter before spawning', async () => {
    const diagnostic = await runMcpPreflight(
      stdioConfig({ preflight: { nodeCommand: 'node', nodeRange: REA_MCP_NODE_RANGE } }),
      { env: { PATH: '/definitely-not-a-directory' }, probe: async () => 'v24.22.1' }
    )
    expect(diagnostic?.code).toBe('COMMAND_MISSING')
    expect(diagnostic?.detail).toBe('node')
  })

  it('reports each declared engine that is absent from PATH', async () => {
    const config = stdioConfig({ preflight: { requiredCommands: ['adb', 'jadx'] } })
    expect(await runMcpPreflight(config, { env: { PATH: binDir } })).toMatchObject({
      code: 'COMMAND_MISSING',
      detail: 'jadx'
    })
    expect(await runMcpPreflight(config, { env: { PATH: binDir } })).toBeDefined()
    const satisfied = stdioConfig({ preflight: { requiredCommands: ['adb', 'node'] } })
    expect(await runMcpPreflight(satisfied, { env: { PATH: binDir } })).toBeUndefined()
  })

  it('only gates stdio, because a remote server runs on someone else’s host', async () => {
    const config = stdioConfig({
      transport: 'streamable-http',
      url: 'https://example.invalid/mcp',
      preflight: { requiredCommands: ['definitely-missing-binary'] }
    })
    expect(await runMcpPreflight(config, { env: { PATH: '/nonexistent' } })).toBeUndefined()
  })

  it('treats a naming report as non-blocking', () => {
    expect(isBlockingPreflightFailure({ code: 'TOOL_NOT_EXPOSABLE' })).toBe(false)
    expect(isBlockingPreflightFailure(undefined)).toBe(false)
    expect(isBlockingPreflightFailure({ code: 'ENGINE_MISSING' })).toBe(true)
  })
})

describe('PATH resolution', () => {
  it('finds an executable by PATH entry and honours PATHEXT on Windows', () => {
    expect(resolveCommandOnPath('node', { PATH: binDir }, 'darwin')).toContain('node')
    expect(resolveCommandOnPath('node', { PATH: '' }, 'darwin')).toBeUndefined()
    expect(resolveCommandOnPath('node', { PATH: binDir, PATHEXT: '.COM;.EXE' }, 'win32')).toContain(
      'node'
    )
  })

  it('checks a path-like command directly instead of searching PATH', () => {
    expect(resolveCommandOnPath(join(binDir, 'adb'), { PATH: '' })).toContain('adb')
    expect(resolveCommandOnPath('./nope', { PATH: binDir })).toBeUndefined()
  })
})
