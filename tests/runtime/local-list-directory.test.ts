import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalListDirectoryTool } from '../../src/runtime/tools/local-list-directory'
import { skipWhenSymlinkUnavailable, tryCreateTestSymlink } from './symlink-fixture'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('local directory listing tool', () => {
  it('lists bounded, sorted metadata without following a symlink', async ({ skip }) => {
    const root = await mkdtemp(join(tmpdir(), 'ola-list-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'ola-list-outside-'))
    cleanup.push(root, outside)
    await mkdir(join(root, 'folder'))
    await writeFile(join(root, 'z.txt'), 'z')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    const linked = await tryCreateTestSymlink(join(outside, 'secret.txt'), join(root, 'escape'))
    skipWhenSymlinkUnavailable({ skip }, linked)
    const tool = createLocalListDirectoryTool(root)
    expect(await tool.execute({ path: '.', limit: 2 }, {} as never)).toEqual([
      { name: 'escape', type: 'symlink' },
      { name: 'folder', type: 'directory' }
    ])
    await expect(tool.resources({ path: '../', limit: 1 }, {} as never)).rejects.toThrow(
      'TOOL_PATH_FORBIDDEN'
    )
  })

  it('rejects unbounded and surplus model input', () => {
    const tool = createLocalListDirectoryTool('/workspace')
    expect(() => tool.validate({ limit: 501 })).toThrow('INVALID_TOOL_INPUT')
    expect(() => tool.validate({ path: '.', recursive: true })).toThrow('INVALID_TOOL_INPUT')
  })

  it('rejects a directory result that cannot safely fit in an event frame', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-list-large-root-'))
    cleanup.push(root)
    await Promise.all(
      Array.from({ length: 500 }, (_, index) =>
        writeFile(join(root, `${String(index).padStart(3, '0')}-${'x'.repeat(100)}`), '')
      )
    )
    const tool = createLocalListDirectoryTool(root)
    await expect(tool.execute({ path: '.', limit: 500 }, {} as never)).rejects.toThrow(
      'TOOL_OUTPUT_TOO_LARGE'
    )
  })
})
