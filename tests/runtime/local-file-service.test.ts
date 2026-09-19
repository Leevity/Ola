import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  deleteLocalPath,
  globLocalFiles,
  listLocalDirectory,
  makeLocalDirectory,
  moveLocalPath,
  readLocalFile,
  readLocalFileBinary,
  readLocalTextFileLines,
  searchLocalFiles,
  statLocalPath,
  writeLocalBinaryFile,
  writeLocalTextFile
} from '../../src/runtime/host/local-file-service'

describe('local file service', () => {
  it('preserves the desktop text, binary, mutation, and metadata contracts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-local-fs-'))
    const textPath = join(root, 'nested', 'note.txt')
    const binaryPath = join(root, 'nested', 'bytes.bin')
    try {
      await expect(writeLocalTextFile(textPath, 'one\ntwo\nthree\n')).resolves.toEqual({
        success: true,
        op: 'create'
      })
      await expect(writeLocalTextFile(textPath, 'one\ntwo\n')).resolves.toEqual({
        success: true,
        op: 'modify'
      })
      await expect(
        readLocalFile({
          path: textPath,
          raw: false,
          offset: 2,
          limit: 1,
          maxFileReadBytes: 1024,
          maxImageReadBytes: 1024
        })
      ).resolves.toBe('     2\ttwo')
      await expect(
        readLocalTextFileLines({ path: textPath, maxLines: 1, maxFileReadBytes: 1024 })
      ).resolves.toMatchObject({
        content: 'one',
        name: 'note.txt',
        lineCount: 1,
        truncated: true
      })
      await expect(
        readLocalFile({
          path: textPath,
          maxFileReadBytes: 1,
          maxImageReadBytes: 1024
        })
      ).resolves.toMatchObject({ error: expect.stringContaining('File too large') })

      await expect(
        writeLocalBinaryFile(binaryPath, Buffer.from([0, 1, 2]).toString('base64'))
      ).resolves.toEqual({
        success: true
      })
      await expect(
        readLocalFileBinary({ path: binaryPath, maxFileReadBytes: 1024 })
      ).resolves.toEqual({
        data: Buffer.from([0, 1, 2]).toString('base64')
      })
      await expect(statLocalPath(binaryPath)).resolves.toMatchObject({
        exists: true,
        type: 'file',
        size: 3
      })

      const movedPath = join(root, 'moved.bin')
      await expect(moveLocalPath(binaryPath, movedPath)).resolves.toEqual({ success: true })
      await expect(readFile(movedPath)).resolves.toEqual(Buffer.from([0, 1, 2]))
      await expect(deleteLocalPath(movedPath)).resolves.toEqual({ success: true })
      await expect(statLocalPath(movedPath)).resolves.toMatchObject({ exists: false })

      const imagePath = join(root, 'image.png')
      await writeFile(imagePath, Buffer.from([1, 2, 3]))
      await expect(
        readLocalFile({
          path: imagePath,
          maxFileReadBytes: 1024,
          maxImageReadBytes: 1024
        })
      ).resolves.toEqual({ kind: 'image', mediaType: 'image/png', data: 'AQID' })
      await expect(makeLocalDirectory(join(root, 'empty', 'child'))).resolves.toEqual({
        success: true
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('matches the legacy directory-listing ignore and item contracts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-local-dir-list-'))
    try {
      await Promise.all([
        mkdir(join(root, 'node_modules')),
        mkdir(join(root, 'ignored-by-gitignore')),
        mkdir(join(root, 'ignored-by-request')),
        mkdir(join(root, 'visible-directory')),
        writeFile(join(root, '.gitignore'), 'ignored-by-gitignore\n*.ignored\n!not-a-negation\n'),
        writeFile(join(root, 'hidden.ignored'), ''),
        writeFile(join(root, 'visible.txt'), ''),
        symlink(join(root, 'visible.txt'), join(root, 'visible-link'))
      ])

      const listed = await listLocalDirectory({
        path: root,
        ignore: ['ignored-by-request'],
        limit: 1_000
      })
      expect(Array.isArray(listed)).toBe(true)
      const items = (listed as Array<{ name: string; type: string; path: string }>)
        .map((item) => ({ ...item, path: item.path === join(root, item.name) }))
        .sort((left, right) => left.name.localeCompare(right.name))
      expect(items).toEqual([
        { name: '.gitignore', type: 'file', path: true },
        { name: 'visible-directory', type: 'directory', path: true },
        { name: 'visible.txt', type: 'file', path: true }
      ])
      await expect(listLocalDirectory({ path: root, limit: 1 })).resolves.toSatisfy(
        (result) => Array.isArray(result) && result.length === 1
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recursively searches with legacy ranking while preserving its ignore rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-local-file-search-'))
    try {
      await Promise.all([
        mkdir(join(root, 'nested')),
        mkdir(join(root, 'ignored')),
        mkdir(join(root, 'node_modules'))
      ])
      await Promise.all([
        writeFile(join(root, '.gitignore'), 'ignored/\n*.private\n'),
        writeFile(join(root, 'README.md'), ''),
        writeFile(join(root, 'nested', 'read-later.md'), ''),
        writeFile(join(root, 'nested', 'notes.txt'), ''),
        writeFile(join(root, 'ignored', 'read-hidden.md'), ''),
        writeFile(join(root, 'secret.private'), ''),
        writeFile(join(root, 'node_modules', 'read-package.md'), '')
      ])

      await expect(searchLocalFiles({ path: root, query: '', limit: 20 })).resolves.toEqual([
        { path: '.gitignore', name: '.gitignore' },
        { path: 'ignored/read-hidden.md', name: 'read-hidden.md' },
        { path: 'nested/notes.txt', name: 'notes.txt' },
        { path: 'nested/read-later.md', name: 'read-later.md' },
        { path: 'README.md', name: 'README.md' }
      ])
      await expect(searchLocalFiles({ path: root, query: 'read', limit: 20 })).resolves.toEqual([
        { path: 'ignored/read-hidden.md', name: 'read-hidden.md' },
        { path: 'nested/read-later.md', name: 'read-later.md' },
        { path: 'README.md', name: 'README.md' }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('glob matches the legacy traversal, depth, ignore, and ordering rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-local-glob-'))
    try {
      const rootTypeScript = join(root, 'root.ts')
      const nested = join(root, 'nested')
      const nestedTypeScript = join(nested, 'nested.ts')
      await mkdir(nested)
      await Promise.all([
        writeFile(join(root, '.gitignore'), 'ignored.txt\n'),
        writeFile(rootTypeScript, ''),
        writeFile(join(root, '.hidden.ts'), ''),
        writeFile(join(root, 'ignored.txt'), ''),
        writeFile(nestedTypeScript, '')
      ])
      await utimes(rootTypeScript, new Date(1_000), new Date(1_000))
      await utimes(nestedTypeScript, new Date(2_000), new Date(2_000))

      await expect(
        globLocalFiles({
          path: root,
          pattern: '**/*.ts',
          limit: 100,
          hidden: false,
          respectGitignore: true,
          maxDepth: null
        })
      ).resolves.toEqual({
        matches: [
          { path: nestedTypeScript, type: 'file' },
          { path: rootTypeScript, type: 'file' }
        ],
        truncated: false
      })
      await expect(
        globLocalFiles({
          path: root,
          pattern: '*',
          limit: 100,
          hidden: false,
          respectGitignore: false,
          maxDepth: 0
        })
      ).resolves.toMatchObject({
        matches: expect.arrayContaining([
          { path: rootTypeScript, type: 'file' },
          { path: join(root, 'ignored.txt'), type: 'file' },
          { path: nested, type: 'directory' }
        ])
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
