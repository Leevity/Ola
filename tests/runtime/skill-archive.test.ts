import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  cleanupSkillTemporaryDirectory,
  materializeSkillArchive
} from '../../src/main/user-content/skill-archive'

describe('skill archive', () => {
  it('materializes text and ZIP skills and only cleans owned temporary paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-skill-archive-'))
    try {
      const text = await materializeSkillArchive({
        temporaryDirectory: root,
        slug: 'writer',
        bytes: Buffer.from('---\nname: writer\ndescription: Test\n---\nBody'),
        isZip: false
      })
      await expect(readFile(join(text.tempPath, 'SKILL.md'), 'utf8')).resolves.toContain(
        'name: writer'
      )
      expect(await cleanupSkillTemporaryDirectory(root, text.tempPath)).toBe(true)
      expect(await cleanupSkillTemporaryDirectory(root, root)).toBe(false)

      const zip = new JSZip()
      zip.file('nested/SKILL.md', '---\nname: archive\ndescription: Test\n---\nBody')
      zip.file('nested/run.ts', 'export {}')
      const bytes = await zip.generateAsync({ type: 'uint8array' })
      const extracted = await materializeSkillArchive({
        temporaryDirectory: root,
        slug: 'archive',
        bytes,
        isZip: true
      })
      expect(extracted.files).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'nested/SKILL.md' })])
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
