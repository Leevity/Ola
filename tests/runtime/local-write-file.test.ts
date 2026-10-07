import { afterEach, describe, expect, it } from 'vitest'
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalWriteFileTool } from '../../src/runtime/tools/local-write-file'
import { skipWhenSymlinkUnavailable, tryCreateTestSymlink } from './symlink-fixture'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('local write file tool', () => {
  it('atomically replaces an existing bounded UTF-8 file inside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-write-root-'))
    cleanup.push(root)
    await mkdir(join(root, 'notes'))
    const target = join(root, 'notes', 'today.txt')
    await writeFile(target, 'old', { mode: 0o600 })
    const tool = createLocalWriteFileTool(root)

    await expect(
      tool.execute({ path: 'notes/today.txt', content: 'new text' }, {
        signal: new AbortController().signal
      } as never)
    ).resolves.toEqual({ path: 'notes/today.txt', bytes: 8, replaced: true })
    expect(await readFile(target, 'utf8')).toBe('new text')
    if (process.platform !== 'win32') expect((await lstat(target)).mode & 0o077).toBe(0)
  })

  it('refuses a symlink escape and does not create missing files', async ({ skip }) => {
    const root = await mkdtemp(join(tmpdir(), 'ola-write-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'ola-write-outside-'))
    cleanup.push(root, outside)
    await writeFile(join(outside, 'secret.txt'), 'keep')
    const tool = createLocalWriteFileTool(root)
    await expect(
      tool.execute({ path: 'missing.txt', content: 'new' }, {
        signal: new AbortController().signal
      } as never)
    ).rejects.toThrow('TOOL_WRITE_FAILED')
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('keep')
    const linked = await tryCreateTestSymlink(outside, join(root, 'escape'), 'dir')
    skipWhenSymlinkUnavailable({ skip }, linked)
    await expect(
      tool.resources({ path: 'escape/secret.txt', content: 'replace' }, {} as never)
    ).rejects.toThrow('TOOL_PATH_FORBIDDEN')
  })

  it('requires exactly a path and bounded content', () => {
    const tool = createLocalWriteFileTool('/workspace')
    expect(() => tool.validate({ path: 'x.txt' })).toThrow('INVALID_TOOL_INPUT')
    expect(() => tool.validate({ path: 'x.txt', content: 'x', overwrite: true })).toThrow(
      'INVALID_TOOL_INPUT'
    )
    expect(() => tool.validate({ path: 'x.txt', content: 'x'.repeat(128 * 1024 + 1) })).toThrow(
      'INVALID_TOOL_INPUT'
    )
  })
})
