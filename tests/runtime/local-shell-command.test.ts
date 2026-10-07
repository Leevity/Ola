import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    const result = await tool.execute(
      {
        command: process.platform === 'win32' ? 'echo hello' : 'printf hello',
        timeoutMs: 5_000
      },
      { signal: new AbortController().signal } as never
    )
    expect(result).toMatchObject({ exitCode: 0, stderr: '', timedOut: false, artifacts: [] })
    expect((result as { stdout: string }).stdout).toContain('hello')
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
    expect(() => tool.validate({ command: 'echo ok', outputFiles: ['a'.repeat(4097)] })).toThrow(
      'INVALID_TOOL_INPUT'
    )
  })

  it('reports only declared files changed by a successful command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-shell-artifact-'))
    cleanup.push(root)
    const tool = createLocalShellCommandTool(root)
    const context = { signal: new AbortController().signal } as never
    const command =
      process.platform === 'win32' ? 'echo hello>result.txt' : 'printf hello > result.txt'

    const created = await tool.execute(
      tool.validate({ command, outputFiles: ['result.txt', 'missing.txt'] }),
      context
    )
    expect(created).toMatchObject({
      exitCode: 0,
      artifacts: [{ path: join(root, 'result.txt'), operation: 'create' }]
    })
    expect(await readFile(join(root, 'result.txt'), 'utf8')).toContain('hello')

    const modified = await tool.execute(
      tool.validate({
        command:
          process.platform === 'win32' ? 'echo changed>result.txt' : 'printf changed > result.txt',
        outputFiles: ['result.txt']
      }),
      context
    )
    expect(modified).toMatchObject({
      exitCode: 0,
      artifacts: [{ path: join(root, 'result.txt'), operation: 'modify' }]
    })

    await writeFile(join(root, 'untouched.txt'), 'before')
    const noChange = await tool.execute(
      tool.validate({
        command: process.platform === 'win32' ? 'echo result.txt' : 'printf result.txt',
        outputFiles: ['untouched.txt']
      }),
      context
    )
    expect(noChange).toMatchObject({ exitCode: 0, artifacts: [] })
  })

  it('does not claim artifacts after a failed command or an escaping declaration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-shell-artifact-'))
    cleanup.push(root)
    const tool = createLocalShellCommandTool(root)
    const context = { signal: new AbortController().signal } as never
    const failed = await tool.execute(
      tool.validate({
        command:
          process.platform === 'win32'
            ? 'echo partial>failed.txt & exit /b 1'
            : 'printf partial > failed.txt; exit 1',
        outputFiles: ['failed.txt']
      }),
      context
    )
    expect(failed).toMatchObject({ exitCode: 1, artifacts: [] })
    await expect(
      tool.execute(tool.validate({ command: 'echo no', outputFiles: ['../outside.txt'] }), context)
    ).rejects.toThrow('TOOL_PATH_FORBIDDEN')
  })
})
