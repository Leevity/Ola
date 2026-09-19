import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CommandCatalog } from '../../src/main/user-content/command-catalog'

async function fixture(): Promise<{
  root: string
  bundled: string
  user: string
  catalog: CommandCatalog
}> {
  const root = await mkdtemp(join(tmpdir(), 'ola-command-catalog-'))
  const bundled = join(root, 'bundled')
  const user = join(root, 'user')
  const catalog = new CommandCatalog({ userDirectory: user, bundledDirectoryCandidates: [bundled] })
  await mkdir(bundled, { recursive: true })
  await catalog.ensure()
  return { root, bundled, user, catalog }
}

describe('CommandCatalog', () => {
  it('keeps bundled commands effective while still showing a user command with the same name', async () => {
    const { root, bundled, user, catalog } = await fixture()
    try {
      await writeFile(join(bundled, 'review.md'), '# Bundled review\nInspect the code.', 'utf8')
      await writeFile(join(user, 'review.md'), '# User review\nUse local conventions.', 'utf8')
      await writeFile(join(user, 'deploy.md'), 'Deploy safely.', 'utf8')

      await expect(catalog.list()).resolves.toEqual([
        { name: 'deploy', summary: 'Deploy safely.' },
        { name: 'review', summary: 'Bundled review' }
      ])
      await expect(catalog.load('REVIEW')).resolves.toMatchObject({
        name: 'review',
        content: '# Bundled review\nInspect the code.'
      })
      await expect(catalog.manageList()).resolves.toEqual([
        expect.objectContaining({
          name: 'deploy',
          source: 'user',
          effective: true,
          editable: true
        }),
        expect.objectContaining({
          name: 'review',
          source: 'bundled',
          effective: true,
          editable: false
        }),
        expect.objectContaining({
          name: 'review',
          source: 'user',
          effective: false,
          editable: true
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('creates and saves validated user commands without allowing bundled or outside paths', async () => {
    const { root, bundled, user, catalog } = await fixture()
    try {
      await writeFile(join(bundled, 'readonly.md'), 'Bundled command.', 'utf8')
      await expect(catalog.manageCreate({ name: 'Ship-Now' })).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('kebab-case')
      })
      await expect(
        catalog.manageCreate({ name: 'ship-now', content: '---\nname: invalid\n---\nbody' })
      ).resolves.toMatchObject({ success: false, error: expect.stringContaining('frontmatter') })

      const created = await catalog.manageCreate({ name: 'ship-now' })
      expect(created).toMatchObject({ success: true, path: join(user, 'ship-now.md') })
      await expect(readFile(join(user, 'ship-now.md'), 'utf8')).resolves.toContain(
        'Describe what /ship-now'
      )
      await expect(
        catalog.manageSave({ path: join(bundled, 'readonly.md'), content: 'Changed' })
      ).resolves.toMatchObject({ success: false, error: 'Only user commands can be edited' })
      await expect(
        catalog.manageSave({ path: join(root, 'outside.md'), content: 'Changed' })
      ).resolves.toMatchObject({ success: false, error: 'Only user commands can be edited' })
      await expect(
        catalog.manageSave({
          path: join(user, 'nested', 'updated.md'),
          content: 'Updated command.'
        })
      ).resolves.toEqual({ success: true })
      await expect(readFile(join(user, 'nested', 'updated.md'), 'utf8')).resolves.toBe(
        'Updated command.'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns structured errors for missing names and paths', async () => {
    const { root, catalog } = await fixture()
    try {
      await expect(catalog.load('')).resolves.toEqual({ error: 'Command name is required' })
      await expect(catalog.load('missing')).resolves.toEqual({
        error: 'Command "missing" not found',
        notFound: true
      })
      await expect(catalog.manageRead('')).resolves.toEqual({ error: 'Command path is required' })
      await expect(catalog.manageRead(join(root, 'outside.md'))).resolves.toEqual({
        error: 'Command path is outside the managed directories'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
