import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateProjectRoot, writeProjectWikiMarkdown } from '../../src/main/wiki/wiki-service'
import type { ProjectWikiDocument } from '../../src/shared/project-wiki'
import { skipWhenSymlinkUnavailable, tryCreateTestSymlink } from './symlink-fixture'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

it('rejects Wiki scans and exports through a linked Ola data root', async ({ skip }) => {
  const directory = await mkdtemp(join(tmpdir(), 'ola-wiki-root-safety-'))
  directories.push(directory)
  const dataRoot = join(directory, 'data-real')
  const linkedRoot = join(directory, 'data-link')
  const project = join(dataRoot, 'project')
  const safeProject = join(directory, 'safe-project')
  await mkdir(project, { recursive: true })
  await mkdir(safeProject)
  const linked = await tryCreateTestSymlink(dataRoot, linkedRoot, 'dir')
  skipWhenSymlinkUnavailable({ skip }, linked)
  expect(() => validateProjectRoot(project, linkedRoot)).toThrow('Ola data directory')
  expect(() => validateProjectRoot(join(linkedRoot, 'project'), linkedRoot)).toThrow(
    'Ola data directory'
  )
  expect(() => validateProjectRoot(join(dataRoot, 'new', 'project'), linkedRoot)).toThrow(
    'Ola data directory'
  )
  expect(validateProjectRoot(safeProject, linkedRoot)).toBe(await realpath(safeProject))

  const document = {} as ProjectWikiDocument
  expect(() => writeProjectWikiMarkdown(document, join(dataRoot, 'wiki.md'), linkedRoot)).toThrow(
    'Wiki export destination'
  )
  expect(() => writeProjectWikiMarkdown(document, join(linkedRoot, 'wiki.md'), linkedRoot)).toThrow(
    'Wiki export destination'
  )
  const protectedFile = join(dataRoot, 'protected.md')
  await writeFile(protectedFile, 'protected')
  const linkedFile = join(directory, 'linked.md')
  const linkedFileCreated = await tryCreateTestSymlink(protectedFile, linkedFile, 'file')
  skipWhenSymlinkUnavailable({ skip }, linkedFileCreated)
  expect(() => writeProjectWikiMarkdown(document, linkedFile, linkedRoot)).toThrow(
    'Wiki export destination'
  )
})
