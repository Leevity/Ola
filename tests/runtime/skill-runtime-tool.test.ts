import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createSkillRuntimeTool } from '../../src/main/runtime/skill-runtime-tool'
import { SkillCatalog, validateSkillManifest } from '../../src/main/user-content/skill-catalog'
import { RuntimeError } from '../../src/shared/runtime/contracts'

const originalDataRoot = process.env.OLA_E2E_DATA_ROOT
let testDataRoot = ''

afterEach(async () => {
  if (testDataRoot) await rm(testDataRoot, { recursive: true, force: true })
  testDataRoot = ''
  if (originalDataRoot === undefined) delete process.env.OLA_E2E_DATA_ROOT
  else process.env.OLA_E2E_DATA_ROOT = originalDataRoot
})

async function useIsolatedDataRoot(): Promise<void> {
  testDataRoot = await mkdtemp(join(tmpdir(), 'ola-skill-runtime-'))
  await writeFile(join(testDataRoot, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
  process.env.OLA_E2E_DATA_ROOT = testDataRoot
}

function runContext() {
  return {
    run: {
      runId: 'run',
      taskId: 'task',
      requestId: 'request',
      traceId: 'trace',
      sessionId: 'session',
      workspaceId: 'local-personal',
      environmentId: 'local',
      modelSource: { kind: 'local' as const, providerId: 'provider', modelId: 'model' },
      prompt: 'inspect',
      toolNames: ['Skill'],
      unattended: false
    },
    signal: new AbortController().signal
  }
}

async function createFixtureSkill(): Promise<void> {
  const skillDirectory = join(testDataRoot, '.agents', 'skills', 'release-check')
  await mkdir(join(skillDirectory, 'references'), { recursive: true })
  await writeFile(
    join(skillDirectory, 'SKILL.md'),
    '---\nname: release-check\ndescription: Check release readiness.\n---\nInspect release gates.\n'
  )
  await writeFile(
    join(skillDirectory, 'references', 'notes.md'),
    '# Notes\n\nReference guidance.\n'
  )
  await writeFile(join(skillDirectory, 'references', 'payload.bin'), 'binary')
  await writeFile(
    join(skillDirectory, 'references', 'huge.md'),
    `# Huge\n\n${'x'.repeat(129 * 1024)}\n`
  )
}

describe('TS Skill runtime tool', () => {
  it('loads only skills present in the Main-owned catalog snapshot', async () => {
    await useIsolatedDataRoot()
    await createFixtureSkill()

    const tool = await createSkillRuntimeTool()
    expect(tool.description).toContain('release-check: Check release readiness.')
    expect(tool.inputSchema.properties).toEqual({
      SkillName: { type: 'string', enum: ['release-check'] },
      FileName: { type: 'string', description: expect.any(String) }
    })
    const input = tool.validate({ SkillName: 'release-check' })
    const result = await tool.execute(input, runContext())
    expect(result).toMatchObject({ skillName: 'release-check', content: 'Inspect release gates.' })
    expect(() => tool.validate({ SkillName: '../outside' })).toThrowError(RuntimeError)
    expect(() => tool.validate({ SkillName: 'not-installed' })).toThrowError(RuntimeError)
  })

  it('returns the skill file list when loading SKILL.md and the body unchanged', async () => {
    await useIsolatedDataRoot()
    await createFixtureSkill()

    const tool = await createSkillRuntimeTool()
    const result = (await tool.execute(
      tool.validate({ SkillName: 'release-check' }),
      runContext()
    )) as {
      content: string
      files: { name: string; size: number; type: string }[]
    }
    expect(result.content).toBe('Inspect release gates.')
    expect(result.files.map((file) => file.name)).toEqual(
      expect.arrayContaining([
        'SKILL.md',
        'references/huge.md',
        'references/notes.md',
        'references/payload.bin'
      ])
    )
  })

  it('loads an allowlisted reference file through FileName', async () => {
    await useIsolatedDataRoot()
    await createFixtureSkill()

    const tool = await createSkillRuntimeTool()
    const input = tool.validate({ SkillName: 'release-check', FileName: 'references/notes.md' })
    const result = (await tool.execute(input, runContext())) as {
      skillName: string
      fileName: string
      content: string
    }
    expect(result).toMatchObject({ skillName: 'release-check', fileName: 'references/notes.md' })
    expect(result.content).toContain('Reference guidance.')
  })

  it('rejects traversal, absolute paths, unknown files and non-text extensions', async () => {
    await useIsolatedDataRoot()
    await createFixtureSkill()

    const tool = await createSkillRuntimeTool()
    expect(() =>
      tool.validate({ SkillName: 'release-check', FileName: '../escape.md' })
    ).toThrowError(RuntimeError)
    expect(() =>
      tool.validate({ SkillName: 'release-check', FileName: 'references/../../escape.md' })
    ).toThrowError(RuntimeError)
    expect(() =>
      tool.validate({ SkillName: 'release-check', FileName: '/etc/passwd.md' })
    ).toThrowError(RuntimeError)
    expect(() =>
      tool.validate({ SkillName: 'release-check', FileName: 'C:\\skills\\x.md' })
    ).toThrowError(RuntimeError)
    expect(() =>
      tool.validate({ SkillName: 'release-check', FileName: 'references/payload.bin' })
    ).toThrowError(RuntimeError)

    // Shape-valid but not present in the catalog listing: execute must reject it.
    const unknown = tool.validate({ SkillName: 'release-check', FileName: 'references/missing.md' })
    await expect(tool.execute(unknown, runContext())).rejects.toThrowError(RuntimeError)
  })

  it('enforces the 128 KB cap on reference files', async () => {
    await useIsolatedDataRoot()
    await createFixtureSkill()

    const tool = await createSkillRuntimeTool()
    const input = tool.validate({ SkillName: 'release-check', FileName: 'references/huge.md' })
    await expect(tool.execute(input, runContext())).rejects.toThrowError(RuntimeError)
  })

  it('bundles reverse-engineer-anything under the real validator and catalog copy path', async () => {
    const skillRoot = fileURLToPath(new URL('../../resources/skills', import.meta.url))
    const skillDirectory = join(skillRoot, 'reverse-engineer-anything')
    const content = await readFile(join(skillDirectory, 'SKILL.md'), 'utf8')

    expect(validateSkillManifest(content, 'reverse-engineer-anything')).toBeUndefined()

    const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)
    expect(frontmatter).not.toBeNull()
    const keys = frontmatter![1]
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trimStart().startsWith('#'))
      .map((line) => line.slice(0, line.indexOf(':')).trim())
    expect([...new Set(keys)].sort()).toEqual(['description', 'name'])

    // The validator counts the trailing element after the final newline; keep the
    // body at or under 440 measured that way. The frontmatter match ends at the
    // closing `---`, so +1 skips the newline that stripFrontmatter also removes.
    const body = content.slice(frontmatter![0].length + 1)
    const bodyLines = body.replace(/\r\n?/g, '\n').split('\n').length
    expect(bodyLines).toBeLessThanOrEqual(440)

    const description = frontmatter![1].match(/^description:\s*(.+)$/m)![1].trim()
    expect(description.length).toBeGreaterThan(0)
    expect(description.length).toBeLessThanOrEqual(1024)

    // ensureBuiltins copies whole directories, so provenance files ride along and
    // listFiles surfaces the reference guides.
    await useIsolatedDataRoot()
    const catalog = new SkillCatalog({
      homeDirectory: testDataRoot,
      bundledDirectoryCandidates: [skillRoot]
    })
    const synced = await catalog.ensureBuiltins()
    expect(synced).toEqual({ success: true })

    const listing = await catalog.listFiles('reverse-engineer-anything')
    if ('error' in listing) throw new Error(listing.error)
    const names = listing.files.map((file) => file.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'SKILL.md',
        'LICENSE.txt',
        'DISCLAIMER.md',
        'references/engines-and-setup.md',
        'references/native-and-artifacts.md',
        'references/javascript-applications.md',
        'references/android-applications.md',
        'references/runtime-observation.md',
        'references/evidence-workflows.md',
        'references/environments.md',
        'references/connection-and-recovery.md'
      ])
    )
    const referenceFiles = await readdir(skillDirectory + '/references')
    expect(referenceFiles.sort()).toEqual(
      [
        'android-applications.md',
        'connection-and-recovery.md',
        'engines-and-setup.md',
        'environments.md',
        'evidence-workflows.md',
        'javascript-applications.md',
        'native-and-artifacts.md',
        'runtime-observation.md'
      ].sort()
    )
  })
})
