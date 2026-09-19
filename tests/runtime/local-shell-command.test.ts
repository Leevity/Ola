import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalShellCommandTool } from '../../src/runtime/tools/local-shell-command'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('local shell command tool', () => {
  it('runs a bounded command in the approved workspace and reports output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-shell-tool-'))
    cleanup.push(root)
    const tool = createLocalShellCommandTool(root)
    await expect(
      tool.execute(
        {
          command: process.platform === 'win32' ? 'echo hello' : 'printf hello',
          timeoutMs: 5_000
        },
        { signal: new AbortController().signal } as never
      )
    ).resolves.toMatchObject({ exitCode: 0, stdout: 'hello', stderr: '', timedOut: false })
  })

  it('rejects unbounded and malformed command inputs', () => {
    const tool = createLocalShellCommandTool('/workspace')
    expect(() => tool.validate({ command: '' })).toThrow('INVALID_TOOL_INPUT')
    expect(() => tool.validate({ command: 'echo ok', timeoutMs: 120_001 })).toThrow(
      'INVALID_TOOL_INPUT'
    )
    expect(() => tool.validate({ command: 'x'.repeat(16 * 1024 + 1) })).toThrow(
      'INVALID_TOOL_INPUT'
    )
  })
})
