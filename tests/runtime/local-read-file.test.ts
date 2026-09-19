import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalReadFileTool } from '../../src/runtime/tools/local-read-file'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('local read file tool', () => {
  it('reads files under its real workspace root and rejects traversal and symlink escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-tool-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'ola-tool-outside-'))
    cleanup.push(root, outside)
    await writeFile(join(root, 'safe.txt'), 'safe')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'))
    const tool = createLocalReadFileTool(root)
    expect(await tool.execute({ path: 'safe.txt' }, {} as never)).toBe('safe')
    await expect(tool.resources({ path: '../secret.txt' }, {} as never)).rejects.toThrow(
      'TOOL_PATH_FORBIDDEN'
    )
    await expect(tool.resources({ path: 'escape.txt' }, {} as never)).rejects.toThrow(
      'TOOL_PATH_FORBIDDEN'
    )
  })
  it('resolves a workspace root from the current run context rather than model input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-tool-dynamic-root-'))
    cleanup.push(root)
    await writeFile(join(root, 'safe.txt'), 'safe')
    const tool = createLocalReadFileTool(async (context) =>
      (context.run as { workingDirectory?: string }).workingDirectory === root ? root : '/missing'
    )
    const context = { run: { workingDirectory: root } } as never
    expect(await tool.execute({ path: 'safe.txt' }, context)).toBe('safe')
    expect(() => tool.validate({ path: 'safe.txt', root: '/etc' })).toThrow('INVALID_TOOL_INPUT')
  })
  it('caps output below the persisted runtime event budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-tool-output-root-'))
    cleanup.push(root)
    await writeFile(join(root, 'large.txt'), 'x'.repeat(32 * 1024 + 1))
    const tool = createLocalReadFileTool(root)
    await expect(tool.execute({ path: 'large.txt' }, {} as never)).rejects.toThrow(
      'TOOL_OUTPUT_TOO_LARGE'
    )
  })
})
