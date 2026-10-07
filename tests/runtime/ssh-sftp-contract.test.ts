import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  copySftpPath,
  downloadSftpPath,
  sftpDeleteFile,
  sftpGlob,
  formatSshTextFileLines,
  sftpMakeDirectory,
  sftpMoveFile,
  sftpReadFile,
  sftpReadRange,
  sftpRealPath,
  sftpStat,
  sftpWriteFile,
  uploadSftpPath,
  scanSftpPath
} from '../../src/main/ipc/ssh-handlers'

// The fake intentionally models the callback-based ssh2 SFTP surface without pulling
// the concrete native binding into the contract test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeSftp(): Record<string, (...args: any[]) => void> {
  return {
    readFile: (_path, callback) => callback(null, Buffer.from('abcdef')),
    writeFile: (_path, _content, callback) => callback(null),
    open: (_path, _flags, callback) => callback(null, { handle: 1 }),
    stat: (path, callback) =>
      path === '/tmp/new' || path === '/remote/folder'
        ? callback(new Error('missing'))
        : callback(null, { size: 6, isDirectory: () => path === '/tmp' }),
    read: (_handle, buffer, _offset, length, position, callback) => {
      Buffer.from('abcdef').copy(buffer, 0, position, position + length)
      callback(null, length)
    },
    close: (_handle, callback) => callback(null),
    mkdir: (_path, callback) => callback(null),
    unlink: (_path, callback) => callback(null),
    rename: (_from, _to, callback) => callback(null),
    realpath: (path, callback) => callback(null, path === '.' ? '/home/test' : `/real${path}`),
    readdir: (path, callback) =>
      callback(null, path === '/remote/folder' ? [{ filename: 'child.txt' }] : [])
  }
}

describe('TS SSH SFTP binary contract', () => {
  it('skips symlink entries when scoped remote searches enumerate files', async () => {
    const file = { isDirectory: () => false, isSymbolicLink: () => false }
    const directory = { isDirectory: () => true, isSymbolicLink: () => false }
    const link = { isDirectory: () => false, isSymbolicLink: () => true }
    const sftp = {
      readdir: (path: string, callback: (error: null, entries: unknown[]) => void) =>
        callback(
          null,
          path === '/srv/project'
            ? [
                { filename: 'inside.txt', attrs: file },
                { filename: 'outside-link', attrs: link },
                { filename: 'sub', attrs: directory }
              ]
            : [{ filename: 'nested.txt', attrs: file }]
        )
    }
    await expect(sftpGlob(sftp as never, '/srv/project', '**/*', true)).resolves.toEqual(
      expect.arrayContaining([
        { path: '/srv/project/inside.txt', type: 'file' },
        { path: '/srv/project/sub/nested.txt', type: 'file' }
      ])
    )
    expect(await sftpGlob(sftp as never, '/srv/project', '**/*', true)).not.toEqual(
      expect.arrayContaining([{ path: '/srv/project/outside-link', type: 'file' }])
    )
  })

  it('reads and writes binary payloads without a native worker', async () => {
    const sftp = fakeSftp()
    await expect(sftpReadFile(sftp as never, '/tmp/a.bin')).resolves.toEqual(Buffer.from('abcdef'))
    await expect(
      sftpWriteFile(sftp as never, '/tmp/a.bin', Buffer.from([1, 2]))
    ).resolves.toBeUndefined()
    await expect(sftpReadRange(sftp as never, '/tmp/a.bin', 2)).resolves.toEqual(
      Buffer.from('cdef')
    )
  })

  it('stats and creates remote directories with existing-directory idempotence', async () => {
    const sftp = fakeSftp()
    await expect(sftpStat(sftp as never, '/tmp')).resolves.toMatchObject({ size: 6 })
    await expect(sftpMakeDirectory(sftp as never, '/tmp/new')).resolves.toBeUndefined()
    await expect(sftpDeleteFile(sftp as never, '/tmp/a')).resolves.toBeUndefined()
    await expect(sftpMoveFile(sftp as never, '/tmp/a', '/tmp/b')).resolves.toBeUndefined()
    await expect(sftpRealPath(sftp as never, '/tmp/a')).resolves.toBe('/real/tmp/a')
    expect(formatSshTextFileLines('a\r\nb\nc', '/tmp/a.txt', 2)).toEqual({
      content: 'a\nb',
      name: 'a.txt',
      path: '/tmp/a.txt',
      lineCount: 3,
      maxLines: 2,
      truncated: true
    })
  })

  it('runs upload, download and remote-copy through the TS SFTP transfer primitives', async () => {
    const sftp = fakeSftp()
    const root = mkdtempSync(join(tmpdir(), 'ola-ssh-'))
    const source = join(root, 'source.txt')
    const downloadDir = join(root, 'downloads')
    writeFileSync(source, 'payload')
    try {
      await expect(uploadSftpPath(sftp as never, source, '/remote')).resolves.toBe(7)
      await expect(
        downloadSftpPath(sftp as never, '/remote/source.txt', downloadDir)
      ).resolves.toBe(6)
      expect(readFileSync(join(downloadDir, 'source.txt'), 'utf8')).toBe('abcdef')
      await expect(
        copySftpPath(sftp as never, sftp as never, '/remote/source.txt', '/remote-copy')
      ).resolves.toBe(6)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('recursively uploads a local directory through the same TS primitive', async () => {
    const sftp = fakeSftp()
    const root = mkdtempSync(join(tmpdir(), 'ola-ssh-dir-'))
    const sourceDir = join(root, 'folder')
    const nested = join(sourceDir, 'nested.txt')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(sourceDir)
    writeFileSync(nested, 'nested')
    try {
      await expect(uploadSftpPath(sftp as never, sourceDir, '/remote')).resolves.toBe(6)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('scans remote transfer scope and byte totals through the TS primitive', async () => {
    const sftp = fakeSftp()
    await expect(scanSftpPath(sftp as never, '/remote/file.txt')).resolves.toEqual({
      entries: [{ path: '/remote/file.txt', kind: 'file', size: 6 }],
      bytes: 6
    })
  })
})
