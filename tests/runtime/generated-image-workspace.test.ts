import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertGeneratedImageSourcePath,
  ensureGeneratedImagesDirectory,
  generatedImagesDirectory,
  validateGeneratedImageRunId
} from '../../src/main/lib/generated-image-path'
import { authorizeGeneratedImageWorkspace } from '../../src/main/ipc/generated-image-workspace'
import { skipWhenSymlinkUnavailable, tryCreateTestSymlink } from './symlink-fixture'

const cleanup: string[] = []

afterEach(async () => {
  for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true })
})

it('puts all new image output under the Ola root while separating managed spaces', () => {
  const userHome = join(tmpdir(), 'ola-user')
  const olaRoot = join(userHome, '.ola')
  expect(generatedImagesDirectory(olaRoot, 'local-personal')).toBe(
    join(olaRoot, 'generated-images')
  )
  const teamA = generatedImagesDirectory(olaRoot, 'team-a')
  const teamB = generatedImagesDirectory(olaRoot, 'team-b')
  expect(teamA).not.toBe(teamB)
  expect(teamA.startsWith(join(olaRoot, 'workspaces'))).toBe(true)
  expect(teamA).not.toContain('team-a')
})

it('rejects other workspace and symlinked GIF source images', async ({ skip }) => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-image-scope-'))
  cleanup.push(directory)
  const teamDir = join(directory, 'team')
  const otherDir = join(directory, 'other')
  await mkdir(teamDir)
  await mkdir(otherDir)
  const own = join(teamDir, 'own.png')
  const foreign = join(otherDir, 'foreign.png')
  await writeFile(own, 'own')
  await writeFile(foreign, 'foreign')
  const linked = await tryCreateTestSymlink(foreign, join(teamDir, 'linked.png'))
  expect(() => assertGeneratedImageSourcePath('team-a', teamDir, own)).not.toThrow()
  expect(() => assertGeneratedImageSourcePath('team-a', teamDir, foreign)).toThrow(
    'outside this workspace'
  )
  skipWhenSymlinkUnavailable({ skip }, linked)
  expect(() =>
    assertGeneratedImageSourcePath('team-a', teamDir, join(teamDir, 'linked.png'))
  ).toThrow('outside this workspace')
  expect(() => assertGeneratedImageSourcePath('local-personal', teamDir, foreign)).not.toThrow()
})

it('rejects a symlinked managed workspace output directory', async ({ skip }) => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-image-output-'))
  cleanup.push(directory)
  const olaRoot = join(directory, '.ola')
  const outside = join(directory, 'outside')
  await mkdir(olaRoot)
  await mkdir(outside)
  const linked = await tryCreateTestSymlink(outside, join(olaRoot, 'workspaces'), 'dir')
  skipWhenSymlinkUnavailable({ skip }, linked)
  expect(() => ensureGeneratedImagesDirectory(olaRoot, 'team-a')).toThrow('not a regular directory')
})

it('rejects a symlinked personal output directory', async ({ skip }) => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-personal-image-output-'))
  cleanup.push(directory)
  const olaRoot = join(directory, '.ola')
  const outside = join(directory, 'outside')
  await mkdir(olaRoot)
  await mkdir(outside)
  const linked = await tryCreateTestSymlink(outside, join(olaRoot, 'generated-images'), 'dir')
  skipWhenSymlinkUnavailable({ skip }, linked)
  expect(() => ensureGeneratedImagesDirectory(olaRoot, 'local-personal')).toThrow(
    'not a regular directory'
  )
})

it('requires explicit available workspace matching the registered image window', async () => {
  const available = async (): Promise<ReadonlySet<string>> => new Set(['team-a'])
  await expect(authorizeGeneratedImageWorkspace('team-a', 'team-a', available)).resolves.toBe(
    'team-a'
  )
  await expect(
    authorizeGeneratedImageWorkspace('team-a', 'local-personal', available)
  ).rejects.toThrow('GENERATED_IMAGE_WINDOW_WORKSPACE_MISMATCH')
  await expect(authorizeGeneratedImageWorkspace('team-b', 'team-b', available)).rejects.toThrow(
    'db-workspace-unavailable'
  )
  await expect(
    authorizeGeneratedImageWorkspace(undefined, 'local-personal', available)
  ).rejects.toThrow('db-workspace-required')
})

it('rejects GIF run identifiers that could escape the output directory', () => {
  expect(validateGeneratedImageRunId('run_A-12')).toBe('run_A-12')
  expect(() => validateGeneratedImageRunId('../outside')).toThrow('Invalid generated image run ID')
  expect(() => validateGeneratedImageRunId('run/other')).toThrow('Invalid generated image run ID')
  expect(() => validateGeneratedImageRunId('')).toThrow('Invalid generated image run ID')
})
