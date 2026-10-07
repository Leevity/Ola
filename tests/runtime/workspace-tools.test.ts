import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createLegacyBashTool,
  createLegacyEditTool,
  createLegacyGlobTool,
  createLegacyGrepTool,
  createLegacyListDirectoryTool,
  createLegacyMonitorTool,
  createLegacyNotebookEditTool,
  createLegacyPowerShellTool,
  createLegacyReadTool,
  createLegacyWriteTool
} from '../../src/runtime/tools/workspace-tools'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('legacy local tool aliases', () => {
  it('keeps established Agent tool names while using confined TS file primitives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-legacy-tools-'))
    cleanup.push(root)
    await writeFile(join(root, 'note.txt'), 'first\nsecond\nthird')
    const context = { signal: new AbortController().signal } as never

    const read = createLegacyReadTool(root)
    expect(read.name).toBe('Read')
    const readInput = read.validate({ file_path: 'note.txt' })
    await expect(read.execute(readInput, context)).resolves.toBe(
      '     1\tfirst\n     2\tsecond\n     3\tthird'
    )
    const page = read.validate({ file_path: 'note.txt', offset: 2, limit: 1 })
    await expect(read.execute(page, context)).resolves.toBe('     2\tsecond')
    expect(() => read.validate({ file_path: 'note.txt', offset: 0 })).toThrow('INVALID_TOOL_INPUT')

    const list = createLegacyListDirectoryTool(root)
    const listInput = list.validate({ path: '.', limit: 10 })
    await expect(list.execute(listInput, context)).resolves.toContainEqual({
      name: 'note.txt',
      type: 'file'
    })

    const glob = createLegacyGlobTool(root)
    const globInput = glob.validate({ pattern: '**/*.txt' })
    await expect(glob.execute(globInput, context)).resolves.toMatchObject({
      truncated: false,
      matches: [
        expect.objectContaining({ path: expect.stringMatching(/[\\/]note\.txt$/), type: 'file' })
      ]
    })
  })

  it('searches bounded workspace text without following paths outside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-legacy-grep-'))
    cleanup.push(root)
    await writeFile(join(root, 'one.ts'), 'const Needle = 1\nconst other = 2')
    await writeFile(join(root, 'two.txt'), 'needle\nneedle')
    const context = { signal: new AbortController().signal } as never
    const grep = createLegacyGrepTool(root)
    const content = grep.validate({
      pattern: 'needle',
      ignoreCase: true,
      glob: '**/*.ts',
      output_mode: 'content'
    })
    await expect(grep.execute(content, context)).resolves.toBe('one.ts:1:const Needle = 1')
    const count = grep.validate({ pattern: 'needle', output_mode: 'count', maxCount: 1 })
    await expect(grep.execute(count, context)).resolves.toContain('two.txt:1')
    expect(() => grep.validate({ pattern: 'needle', context: 3 })).toThrow('INVALID_TOOL_INPUT')
  })

  it('maps only the legacy Bash timeout field and preserves write classification', () => {
    const tool = createLegacyBashTool('/workspace')
    expect(tool.name).toBe('Bash')
    expect(tool.effect).toBe('write')
    expect(tool.validate({ command: 'echo ok', timeout: 5000 })).toEqual({
      command: 'echo ok',
      timeoutMs: 5000,
      outputFiles: []
    })
    expect(() => tool.validate({ command: 'echo ok', timeoutMs: 5000 })).toThrow(
      'INVALID_TOOL_INPUT'
    )
  })

  it('maps PowerShell and Monitor to bounded Main-owned shell requests', async () => {
    const powershell = createLegacyPowerShellTool('/workspace')
    expect(powershell.name).toBe('PowerShell')
    expect(powershell.effect).toBe('write')
    expect(powershell.validate({ command: 'Write-Output ready', timeout: 5000 })).toMatchObject({
      command: 'Write-Output ready',
      timeoutMs: 5000,
      outputFiles: []
    })
    expect(() => powershell.validate({ command: 'Write-Output ready', shell: 'cmd.exe' })).toThrow(
      'INVALID_TOOL_INPUT'
    )

    const monitor = createLegacyMonitorTool('/workspace')
    expect(monitor.name).toBe('Monitor')
    expect(monitor.effect).toBe('write')
    expect(monitor.validate({ command: 'echo ready', description: 'Check local state' })).toEqual({
      command: 'echo ready',
      timeoutMs: 600_000,
      outputFiles: []
    })
    expect(() => monitor.validate({ command: 'echo ready', description: 'x'.repeat(513) })).toThrow(
      'INVALID_TOOL_INPUT'
    )

    if (process.platform === 'win32') {
      const root = await mkdtemp(join(tmpdir(), 'ola-powershell-tool-'))
      cleanup.push(root)
      const command = createLegacyPowerShellTool(root)
      const output = await command.execute(
        command.validate({ command: 'Write-Output runtime-ok', timeout: 10_000 }),
        { signal: new AbortController().signal } as never
      )
      expect(output).toMatchObject({ exitCode: 0, timedOut: false })
      expect((output as { stdout: string }).stdout).toContain('runtime-ok')
    }
  })

  it('creates or atomically replaces through Write and refuses ambiguous Edit input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-legacy-write-'))
    cleanup.push(root)
    const context = { signal: new AbortController().signal } as never
    const write = createLegacyWriteTool(root)

    const create = write.validate({ file_path: 'new.txt', content: 'first' })
    await expect(write.execute(create, context)).resolves.toMatchObject({ path: 'new.txt' })
    const replace = write.validate({ file_path: 'new.txt', content: 'second' })
    await write.execute(replace, context)

    const edit = createLegacyEditTool(root)
    const editInput = edit.validate({
      file_path: 'new.txt',
      old_string: 'second',
      new_string: 'updated'
    })
    await expect(edit.execute(editInput, context)).resolves.toMatchObject({ path: 'new.txt' })
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('updated')
    expect(() =>
      edit.validate({ file_path: 'new.txt', old_string: 'updated', new_string: 'updated' })
    ).toThrow('INVALID_TOOL_INPUT')
    await writeFile(join(root, 'ambiguous.txt'), 'repeat repeat')
    const ambiguous = edit.validate({
      file_path: 'ambiguous.txt',
      old_string: 'repeat',
      new_string: 'done'
    })
    await expect(edit.execute(ambiguous, context)).rejects.toThrow('EDIT_STRING_AMBIGUOUS')
  })

  it('edits Jupyter cells through confined and approval-gated workspace writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-notebook-edit-'))
    cleanup.push(root)
    const notebookPath = join(root, 'analysis.ipynb')
    await writeFile(
      notebookPath,
      JSON.stringify({
        cells: [
          {
            cell_type: 'code',
            id: 'stable-cell-id',
            metadata: { tags: ['keep'] },
            execution_count: 1,
            outputs: [],
            source: ['print(1)']
          }
        ],
        metadata: { kernelspec: { name: 'python3' } },
        nbformat: 4,
        nbformat_minor: 5
      })
    )
    const tool = createLegacyNotebookEditTool(root)
    expect(tool.effect).toBe('write')
    const input = tool.validate({
      notebook_path: 'analysis.ipynb',
      cell_id: 'stable-cell-id',
      new_source: 'print(2)\n'
    })
    const context = { signal: new AbortController().signal } as never
    await expect(tool.resources(input, context)).resolves.toEqual([notebookPath])
    await expect(tool.execute(input, context)).resolves.toMatchObject({
      path: 'analysis.ipynb',
      replaced: true
    })
    const notebook = JSON.parse(await readFile(notebookPath, 'utf8')) as {
      cells: Array<Record<string, unknown>>
    }
    expect(notebook.cells[0]).toMatchObject({
      id: 'stable-cell-id',
      metadata: { tags: ['keep'] },
      source: ['print(2)\n']
    })
    expect(() =>
      tool.validate({ notebook_path: '../outside.ipynb', cell_index: 0, new_source: '' })
    ).not.toThrow()
    await expect(
      tool.resources(
        tool.validate({ notebook_path: '../outside.ipynb', cell_index: 0, new_source: '' }),
        context
      )
    ).rejects.toThrow('TOOL_PATH_FORBIDDEN')
    expect(() =>
      tool.validate({ notebook_path: 'analysis.ipynb', cell_index: -1, new_source: '' })
    ).toThrow('INVALID_TOOL_INPUT')
  })
})
