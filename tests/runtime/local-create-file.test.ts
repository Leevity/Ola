import { afterEach, describe, expect, it } from 'vitest'
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalCreateFileTool } from '../../src/runtime/tools/local-create-file'
import { skipWhenSymlinkUnavailable, tryCreateTestSymlink } from './symlink-fixture'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('local create file tool', () => {
  it('creates a bounded UTF-8 file beneath an existing real workspace parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-create-root-'))
    cleanup.push(root)
    await mkdir(join(root, 'notes'))
    const tool = createLocalCreateFileTool(root)
    await expect(
      tool.execute({ path: 'notes/today.txt', content: 'hello' }, {
        signal: new AbortController().signal
      } as never)
    ).resolves.toEqual({ path: 'notes/today.txt', bytes: 5 })
    expect(await readFile(join(root, 'notes', 'today.txt'), 'utf8')).toBe('hello')
    if (process.platform !== 'win32')
      expect((await lstat(join(root, 'notes', 'today.txt'))).mode & 0o077).toBe(0)
  })

  it('does not overwrite an existing file or follow an escaped parent symlink', async ({
    skip
  }) => {
    const root = await mkdtemp(join(tmpdir(), 'ola-create-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'ola-create-outside-'))
    cleanup.push(root, outside)
    await mkdir(join(root, 'safe'))
    await writeFile(join(root, 'safe', 'exists.txt'), 'keep')
    const tool = createLocalCreateFileTool(root)
    await expect(
      tool.execute({ path: 'safe/exists.txt', content: 'replace' }, {
        signal: new AbortController().signal
      } as never)
    ).rejects.toThrow('TOOL_WRITE_FAILED')
    expect(await readFile(join(root, 'safe', 'exists.txt'), 'utf8')).toBe('keep')
    const linked = await tryCreateTestSymlink(outside, join(root, 'escape'), 'dir')
    skipWhenSymlinkUnavailable({ skip }, linked)
    await expect(
      tool.resources({ path: 'escape/nope.txt', content: 'no' }, {} as never)
    ).rejects.toThrow('TOOL_PATH_FORBIDDEN')
  })

  it('requires exactly a file path and bounded content', () => {
    const tool = createLocalCreateFileTool('/workspace')
    expect(() => tool.validate({ path: 'x.txt' })).toThrow('INVALID_TOOL_INPUT')
    expect(() => tool.validate({ path: 'x.txt', content: 'x', overwrite: true })).toThrow(
      'INVALID_TOOL_INPUT'
    )
    expect(() => tool.validate({ path: 'x.txt', content: 'x'.repeat(128 * 1024 + 1) })).toThrow(
      'INVALID_TOOL_INPUT'
    )
  })
})
