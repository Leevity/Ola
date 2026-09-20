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
        expect.objectContaining({ path: expect.stringMatching(/\/note\.txt$/), type: 'file' })
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
      timeoutMs: 5000
    })
    expect(() => tool.validate({ command: 'echo ok', timeoutMs: 5000 })).toThrow(
      'INVALID_TOOL_INPUT'
    )
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
})
