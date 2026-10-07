import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillRuntimeTool } from '../../src/main/runtime/skill-runtime-tool'
import { RuntimeError } from '../../src/shared/runtime/contracts'

const originalDataRoot = process.env.OLA_E2E_DATA_ROOT
let testDataRoot = ''

afterEach(async () => {
  if (testDataRoot) await rm(testDataRoot, { recursive: true, force: true })
  testDataRoot = ''
  if (originalDataRoot === undefined) delete process.env.OLA_E2E_DATA_ROOT
  else process.env.OLA_E2E_DATA_ROOT = originalDataRoot
})

describe('TS Skill runtime tool', () => {
  it('loads only skills present in the Main-owned catalog snapshot', async () => {
    testDataRoot = await mkdtemp(join(tmpdir(), 'ola-skill-runtime-'))
    await writeFile(join(testDataRoot, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
    process.env.OLA_E2E_DATA_ROOT = testDataRoot
    const skillDirectory = join(testDataRoot, '.agents', 'skills', 'release-check')
    await mkdir(skillDirectory, { recursive: true })
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      '---\nname: release-check\ndescription: Check release readiness.\n---\nInspect release gates.\n'
    )

    const tool = await createSkillRuntimeTool()
    expect(tool.description).toContain('release-check: Check release readiness.')
    expect(tool.inputSchema.properties).toEqual({
      SkillName: { type: 'string', enum: ['release-check'] }
    })
    const input = tool.validate({ SkillName: 'release-check' })
    const result = await tool.execute(input, {
      run: {
        runId: 'run',
        taskId: 'task',
        requestId: 'request',
        traceId: 'trace',
        sessionId: 'session',
        workspaceId: 'local-personal',
        environmentId: 'local',
        modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
        prompt: 'inspect',
        toolNames: ['Skill'],
        unattended: false
      },
      signal: new AbortController().signal
    })
    expect(result).toMatchObject({ skillName: 'release-check', content: 'Inspect release gates.' })
    expect(() => tool.validate({ SkillName: '../outside' })).toThrowError(RuntimeError)
    expect(() => tool.validate({ SkillName: 'not-installed' })).toThrowError(RuntimeError)
  })
})
