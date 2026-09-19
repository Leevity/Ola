import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentCatalog, parseAgentMarkdown } from '../../src/main/user-content/agent-catalog'

const bundledAgent = `---
name: reviewer
description: Review changes carefully.
allowedTools: Read, Grep
maxIterations: 3
profiles: [code, both]
recommended: true
---

Review the requested changes.`

describe('AgentCatalog', () => {
  it('parses legacy agent frontmatter and keeps the body as the system prompt', () => {
    expect(parseAgentMarkdown(bundledAgent)).toMatchObject({
      name: 'reviewer',
      tools: ['Read', 'Grep'],
      allowedTools: ['Read', 'Grep'],
      maxTurns: 3,
      maxIterations: 3,
      profiles: ['code', 'both'],
      recommended: true,
      systemPrompt: 'Review the requested changes.'
    })
    expect(parseAgentMarkdown('missing frontmatter')).toBeNull()
  })

  it('copies bundled agents once, detects overrides, and rejects invalid or outside saves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-agent-catalog-'))
    const bundled = join(root, 'bundled')
    const user = join(root, 'user')
    const catalog = new AgentCatalog({ userDirectory: user, bundledDirectoryCandidates: [bundled] })
    try {
      await mkdir(bundled, { recursive: true })
      await writeFile(join(bundled, 'reviewer.md'), bundledAgent, 'utf8')
      await expect(catalog.ensure()).resolves.toEqual({ success: true })
      await expect(catalog.list()).resolves.toEqual([expect.objectContaining({ name: 'reviewer' })])
      await expect(catalog.manageList()).resolves.toEqual([
        expect.objectContaining({ source: 'bundled', editable: false })
      ])

      const overridden = bundledAgent.replace('Review changes carefully.', 'Review changed code.')
      await expect(
        catalog.manageSave({ path: join(user, 'reviewer.md'), content: overridden })
      ).resolves.toEqual({ success: true })
      await expect(catalog.manageList()).resolves.toEqual([
        expect.objectContaining({ source: 'overridden', editable: true })
      ])
      await expect(readFile(join(user, 'reviewer.md'), 'utf8')).resolves.toBe(overridden)
      await expect(
        catalog.manageSave({ path: join(root, 'outside.md'), content: bundledAgent })
      ).resolves.toMatchObject({ success: false, error: expect.stringContaining('outside') })
      await expect(
        catalog.manageSave({ path: join(user, 'reviewer.md'), content: 'bad' })
      ).resolves.toMatchObject({ success: false, error: expect.stringContaining('invalid') })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
