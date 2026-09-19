import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SoulLocalCatalog } from '../../src/main/user-content/soul-local-catalog'

describe('SoulLocalCatalog', () => {
  it('reads declared bundled templates and writes global and project targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-soul-catalog-'))
    const bundled = join(root, 'bundled')
    const home = join(root, 'home')
    const project = join(root, 'project')
    const catalog = new SoulLocalCatalog({
      homeDirectory: home,
      bundledDirectoryCandidates: [bundled]
    })
    try {
      await mkdir(bundled, { recursive: true })
      await writeFile(join(bundled, 'balanced.md'), 'Builtin soul', 'utf8')
      await expect(
        catalog.builtinList([
          {
            id: 'balanced',
            name: 'Balanced',
            description: 'Default',
            category: 'general',
            tags: ['daily'],
            filename: 'balanced.md'
          }
        ])
      ).resolves.toEqual({
        templates: [
          expect.objectContaining({
            id: 'balanced',
            tags: ['daily'],
            content: 'Builtin soul'
          })
        ]
      })
      expect(catalog.targetPaths(project)).toEqual({
        global: { available: true, path: join(home, '.ola', 'SOUL.md') },
        project: { available: true, path: join(project, '.agents', 'SOUL.md') }
      })
      await expect(catalog.install({ content: 'Global soul' })).resolves.toEqual({
        success: true,
        path: join(home, '.ola', 'SOUL.md')
      })
      await expect(readFile(join(home, '.ola', 'SOUL.md'), 'utf8')).resolves.toBe('Global soul')
      await expect(
        catalog.install({ content: 'Project soul', target: 'project', projectRootPath: project })
      ).resolves.toEqual({ success: true, path: join(project, '.agents', 'SOUL.md') })
      await expect(readFile(join(project, '.agents', 'SOUL.md'), 'utf8')).resolves.toBe(
        'Project soul'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns actionable errors for unavailable templates and invalid project installs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-soul-catalog-'))
    const catalog = new SoulLocalCatalog({
      homeDirectory: join(root, 'home'),
      bundledDirectoryCandidates: [join(root, 'missing')]
    })
    try {
      await expect(catalog.builtinList([])).resolves.toMatchObject({
        templates: [],
        error: expect.stringContaining('unavailable')
      })
      await expect(catalog.install({ content: '   ' })).resolves.toEqual({
        success: false,
        error: 'SOUL content is empty'
      })
      await expect(catalog.install({ content: 'x', target: 'project' })).resolves.toEqual({
        success: false,
        error: 'Project SOUL target is unavailable'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('supports an explicit Ola data root for the global Soul target', () => {
    const catalog = new SoulLocalCatalog({
      homeDirectory: join('/tmp', 'home'),
      olaDataRoot: join('/tmp', 'isolated-ola'),
      bundledDirectoryCandidates: []
    })
    expect(catalog.targetPaths().global.path).toBe(join('/tmp', 'isolated-ola', 'SOUL.md'))
  })
})
