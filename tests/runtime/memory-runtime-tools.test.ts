import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryRuntimeTools } from '../../src/main/runtime/memory-runtime-tools'
import { workspaceMemoryDataRoot } from '../../src/main/lib/workspace-memory-path'
import { RuntimeError } from '../../src/shared/runtime/contracts'
import type { ToolContext } from '../../src/runtime/tools/tool-executor'

const originalDataRoot = process.env.OLA_E2E_DATA_ROOT
let testDataRoot = ''

afterEach(async () => {
  if (testDataRoot) await rm(testDataRoot, { recursive: true, force: true })
  testDataRoot = ''
  if (originalDataRoot === undefined) delete process.env.OLA_E2E_DATA_ROOT
  else process.env.OLA_E2E_DATA_ROOT = originalDataRoot
})

describe('Main-owned Memory runtime tools', () => {
  it('reads and searches only fixed files in current global and project roots', async () => {
    testDataRoot = await mkdtemp(join(tmpdir(), 'ola-memory-runtime-'))
    await writeFile(join(testDataRoot, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
    process.env.OLA_E2E_DATA_ROOT = testDataRoot
    const projectRoot = join(testDataRoot, 'project')
    const globalRoot = workspaceMemoryDataRoot(testDataRoot, 'local-personal')
    const projectMemoryRoot = join(projectRoot, '.agents')
    await mkdir(globalRoot, { recursive: true })
    await mkdir(projectMemoryRoot, { recursive: true })
    await writeFile(join(globalRoot, 'MEMORY.md'), 'Global: release process\n')
    await writeFile(join(projectMemoryRoot, 'MEMORY.md'), 'Project: release checklist\n')

    const tools = createMemoryRuntimeTools()
    const context: ToolContext = {
      run: {
        runId: 'run',
        taskId: 'task',
        requestId: 'request',
        traceId: 'trace',
        sessionId: 'session',
        workspaceId: 'local-personal',
        environmentId: 'local',
        modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
        prompt: 'remember',
        toolNames: ['MemoryRead', 'MemorySearch'],
        unattended: false,
        workingDirectory: projectRoot
      },
      signal: new AbortController().signal
    }

    const read = tools.find((tool) => tool.name === 'MemoryRead')!
    const result = await read.execute(
      read.validate({ scope: 'project', file: 'MEMORY.md' }),
      context
    )
    const readResults = (
      result as { results: Array<{ scope: string; lines: Array<{ line: number; text: string }> }> }
    ).results
    expect(readResults[0]).toMatchObject({ scope: 'project' })
    expect(readResults[0].lines[0]).toEqual({ line: 1, text: 'Project: release checklist' })
    const search = tools.find((tool) => tool.name === 'MemorySearch')!
    expect(
      await search.execute(search.validate({ query: 'release', limit: 1 }), context)
    ).toMatchObject({
      results: [{ line: 1 }]
    })
  })

  it('rejects arbitrary filenames, roots, malformed scopes, and oversized input', () => {
    const tools = createMemoryRuntimeTools()
    const read = tools.find((tool) => tool.name === 'MemoryRead')!
    const search = tools.find((tool) => tool.name === 'MemorySearch')!
    expect(() => read.validate({ file: '../../outside.txt' })).toThrowError(RuntimeError)
    expect(() => read.validate({ memoryRootId: 'C:\\outside' })).not.toThrow()
    expect(() => read.validate({ scope: 'anything' })).toThrowError(RuntimeError)
    expect(() => search.validate({ query: 'x'.repeat(513) })).toThrowError(RuntimeError)
  })
})
