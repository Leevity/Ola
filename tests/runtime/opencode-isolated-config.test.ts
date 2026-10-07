import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  getOpenCodeConfigPath,
  parseOpenCodeConfig
} from '../../src/main/migration/opencode-parser'

const originalRoot = process.env.OLA_E2E_DATA_ROOT
const originalTestInstruction = process.env.OLA_E2E_TEST_INSTRUCTION
const originalHome = process.env.HOME
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  if (originalRoot === undefined) delete process.env.OLA_E2E_DATA_ROOT
  else process.env.OLA_E2E_DATA_ROOT = originalRoot
  if (originalTestInstruction === undefined) delete process.env.OLA_E2E_TEST_INSTRUCTION
  else process.env.OLA_E2E_TEST_INSTRUCTION = originalTestInstruction
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('reads OpenCode import configuration only from the isolated simulated home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ola-opencode-isolated-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
  const configPath = join(root, '.config', 'opencode', 'opencode.json')
  await mkdir(join(root, '.config', 'opencode'), { recursive: true })
  await writeFile(configPath, '{}')
  process.env.OLA_E2E_DATA_ROOT = root

  expect(getOpenCodeConfigPath()).toBe(configPath)
  expect(parseOpenCodeConfig()).toMatchObject({ sourcePath: configPath, exists: true })
})

it('does not import instruction paths or globs outside the isolated root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-opencode-instructions-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'isolated')
  const configDir = join(root, '.config', 'opencode')
  const outsideFile = join(directory, 'outside.md')
  await mkdir(configDir, { recursive: true })
  await writeFile(join(root, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
  await writeFile(join(configDir, 'inside.md'), 'inside only')
  await writeFile(outsideFile, 'HOST SECRET')
  const entries = [
    'inside.md',
    '*.md',
    outsideFile,
    relative(configDir, outsideFile),
    join(directory, '*.md')
  ]
  if (platform() !== 'win32') {
    await symlink(outsideFile, join(configDir, 'linked.md'))
    entries.push('linked.md')
  }
  await writeFile(join(configDir, 'opencode.json'), JSON.stringify({ instructions: entries }))
  process.env.OLA_E2E_DATA_ROOT = root

  const parsed = parseOpenCodeConfig()
  expect(parsed.instructions.resolvedFiles.map((file) => file.content)).toEqual(['inside only'])
  expect(parsed.instructions.unresolved.map((item) => item.source)).toEqual(entries.slice(2))
  expect(parsed.instructions.managedContent).not.toContain('HOST SECRET')
})

it.skipIf(platform() === 'win32')(
  'rejects a configuration symlink escaping the isolated root',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-opencode-config-link-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const root = join(directory, 'isolated')
    const configDir = join(root, '.config', 'opencode')
    const outsideConfig = join(directory, 'outside.json')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(root, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
    await writeFile(outsideConfig, JSON.stringify({ instructions: [] }))
    await symlink(outsideConfig, join(configDir, 'opencode.json'))
    process.env.OLA_E2E_DATA_ROOT = root

    const parsed = parseOpenCodeConfig()
    expect(parsed.exists).toBe(false)
    expect(parsed.warnings).toContain('OpenCode configuration is outside isolated Ola data root')
  }
)

it('does not expand host environment secrets from an isolated import config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ola-opencode-env-isolated-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const configDir = join(root, '.config', 'opencode')
  await mkdir(configDir, { recursive: true })
  await writeFile(join(root, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
  await writeFile(join(configDir, 'inside.md'), 'isolated instruction')
  await writeFile(
    join(configDir, 'opencode.json'),
    JSON.stringify({ instructions: ['{env:HOME}', '{env:OLA_E2E_TEST_INSTRUCTION}'] })
  )
  process.env.OLA_E2E_DATA_ROOT = root
  process.env.OLA_E2E_TEST_INSTRUCTION = 'inside.md'
  process.env.HOME = 'OLA_HOST_HOME_SECRET'

  const parsed = parseOpenCodeConfig()
  expect(parsed.warnings).toContain(
    'Environment variable HOME is unavailable in isolated E2E: opencode.json.instructions[0]'
  )
  expect(parsed.instructions.resolvedFiles.map((file) => file.content)).toEqual([
    'isolated instruction'
  ])
  expect(parsed.instructions.managedContent).not.toContain('OLA_HOST_HOME_SECRET')
})
