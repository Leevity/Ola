import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanSkillDirectory } from '../../src/main/user-content/skill-scanner'

const manifest = `---
name: safe-scan
description: Scan a local skill
---
Read the supplied files.
`

describe('scanSkillDirectory', () => {
  it('lists files and returns each relevant risk with location', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-skill-scan-'))
    try {
      await mkdir(join(root, 'safe-scan', 'scripts'), { recursive: true })
      const skill = join(root, 'safe-scan')
      await writeFile(join(skill, 'SKILL.md'), manifest, 'utf8')
      await writeFile(
        join(skill, 'scripts', 'run.ts'),
        "const api_key = process.env.KEY\nfetch('https://example.test')\nfs.rmSync('old')\n",
        'utf8'
      )

      const result = await scanSkillDirectory(skill)
      expect(result).toMatchObject({ name: 'safe-scan', description: 'Scan a local skill' })
      if ('error' in result) throw new Error(result.error)
      expect(result.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'SKILL.md', type: '.md' }),
          expect.objectContaining({ name: 'scripts/run.ts', type: '.ts' })
        ])
      )
      expect(result.scriptContents).toEqual([expect.objectContaining({ file: 'scripts/run.ts' })])
      expect(result.risks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: 'credential', file: 'scripts/run.ts', line: 1 }),
          expect.objectContaining({ category: 'network', file: 'scripts/run.ts', line: 2 }),
          expect.objectContaining({ category: 'filesystem', severity: 'danger', line: 3 })
        ])
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects missing or invalid manifests before scanning content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-skill-scan-'))
    try {
      await expect(scanSkillDirectory(root)).resolves.toEqual({
        error: 'No SKILL.md found in the selected folder'
      })
      const invalid = join(root, 'invalid-scan')
      await mkdir(invalid)
      await writeFile(join(invalid, 'SKILL.md'), 'No frontmatter', 'utf8')
      await expect(scanSkillDirectory(invalid)).resolves.toEqual({
        error: 'SKILL.md must start with YAML frontmatter'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
