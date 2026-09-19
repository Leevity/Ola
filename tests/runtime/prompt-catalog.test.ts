import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PromptCatalog } from '../../src/main/user-content/prompt-catalog'

describe('PromptCatalog', () => {
  it('copies bundled prompts once and reads the local copy as the effective template', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-prompt-catalog-'))
    const bundled = join(root, 'bundled')
    const user = join(root, 'user')
    const catalog = new PromptCatalog({
      userDirectory: user,
      bundledDirectoryCandidates: [bundled]
    })
    try {
      await mkdir(bundled, { recursive: true })
      await writeFile(join(bundled, 'review.md'), 'Bundled prompt', 'utf8')
      await expect(catalog.list()).resolves.toEqual(['review'])
      await expect(readFile(join(user, 'review.md'), 'utf8')).resolves.toBe('Bundled prompt')
      await writeFile(join(user, 'review.md'), 'User prompt', 'utf8')
      await expect(catalog.load('review')).resolves.toEqual({ content: 'User prompt' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('normalizes extensions and rejects missing or traversal-only names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-prompt-catalog-'))
    const user = join(root, 'user')
    const catalog = new PromptCatalog({
      userDirectory: user,
      bundledDirectoryCandidates: [join(root, 'missing')]
    })
    try {
      await mkdir(user, { recursive: true })
      await writeFile(join(user, 'safe.md'), 'Safe', 'utf8')
      await expect(catalog.load('safe.md')).resolves.toEqual({ content: 'Safe' })
      await expect(catalog.load('')).resolves.toEqual({ error: 'Prompt name is required' })
      await expect(catalog.load('../')).resolves.toEqual({ error: 'Prompt name is required' })
      await expect(catalog.load('../missing')).resolves.toEqual({
        error: 'Prompt "../missing" not found'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
