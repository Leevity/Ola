import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SkillCatalog } from '../../src/main/user-content/skill-catalog'

const manifest = (name: string, description = 'A test skill', body = 'Use this safely.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`

async function fixture(): Promise<{
  root: string
  bundled: string
  home: string
  catalog: SkillCatalog
}> {
  const root = await mkdtemp(join(tmpdir(), 'ola-skill-catalog-'))
  const bundled = join(root, 'bundled')
  const home = join(root, 'home')
  await mkdir(bundled, { recursive: true })
  return {
    root,
    bundled,
    home,
    catalog: new SkillCatalog({ homeDirectory: home, bundledDirectoryCandidates: [bundled] })
  }
}

describe('SkillCatalog', () => {
  it('synchronizes bundled skills, keeps a local edit, and exposes skill content', async () => {
    const { root, bundled, home, catalog } = await fixture()
    try {
      const source = join(bundled, 'review')
      await mkdir(join(source, 'scripts'), { recursive: true })
      await writeFile(join(source, 'SKILL.md'), manifest('review', 'Review a change'), 'utf8')
      await writeFile(join(source, 'scripts', 'check.ts'), 'export {}', 'utf8')

      await expect(catalog.ensureBuiltins()).resolves.toEqual({ success: true })
      await expect(catalog.list()).resolves.toEqual([
        { name: 'review', description: 'Review a change' }
      ])
      await expect(catalog.load('review')).resolves.toEqual({
        content: 'Use this safely.\n',
        workingDirectory: join(home, '.agents', 'skills', 'review')
      })
      await expect(catalog.listFiles('review')).resolves.toEqual({
        files: [
          { name: '.ola-builtin.json', size: expect.any(Number), type: '.json' },
          { name: 'scripts/check.ts', size: 9, type: '.ts' },
          { name: 'SKILL.md', size: expect.any(Number), type: '.md' }
        ]
      })

      const localManifest = join(home, '.agents', 'skills', 'review', 'SKILL.md')
      await writeFile(localManifest, manifest('review', 'Locally changed'), 'utf8')
      await writeFile(join(source, 'SKILL.md'), manifest('review', 'Bundled v2'), 'utf8')
      await catalog.ensureBuiltins()
      await expect(readFile(localManifest, 'utf8')).resolves.toContain('Locally changed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('imports, saves, deletes, and rejects invalid names or manifests', async () => {
    const { root, home, catalog } = await fixture()
    try {
      const source = join(root, 'writer')
      await mkdir(source, { recursive: true })
      await writeFile(join(source, 'SKILL.md'), manifest('writer'), 'utf8')
      await expect(catalog.addFromFolder(source)).resolves.toEqual({
        success: true,
        name: 'writer'
      })
      await expect(catalog.save('writer', manifest('writer', 'Updated'))).resolves.toEqual({
        success: true
      })
      await expect(
        readFile(join(home, '.agents', 'skills', 'writer', 'SKILL.md'), 'utf8')
      ).resolves.toContain('Updated')
      await expect(catalog.save('writer', 'no frontmatter')).resolves.toEqual({
        success: false,
        error: 'SKILL.md must start with YAML frontmatter'
      })
      await expect(catalog.read('../writer')).resolves.toEqual({ error: 'Invalid skill name' })
      await expect(catalog.delete('writer')).resolves.toEqual({ success: true })
      await expect(catalog.resolvePath('writer')).resolves.toEqual({
        success: false,
        error: 'Skill "writer" not found'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
