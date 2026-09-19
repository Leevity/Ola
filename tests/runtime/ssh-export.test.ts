import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeSshConfigDocument } from '../../src/main/ssh/ssh-config-json'
import { buildSshExportPayload, writeSshExportFile } from '../../src/main/ssh/ssh-export'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

const config = normalizeSshConfigDocument({
  groups: [
    { id: 'first', name: 'First', createdAt: 1 },
    { id: 'second', name: 'Second', createdAt: 2 }
  ],
  connections: [
    { id: 'a', groupId: 'first', name: 'A', host: 'a.invalid', username: 'alice', password: 's1' },
    { id: 'b', groupId: 'second', name: 'B', host: 'b.invalid', username: 'bob', password: 's2' }
  ]
})

describe('TS SSH export', () => {
  it('matches Native selection semantics and includes only referenced groups', () => {
    expect(buildSshExportPayload(config, ['a'], 123)).toMatchObject({
      schemaVersion: 1,
      source: 'ola-ssh',
      exportedAt: 123,
      groups: [{ id: 'first' }],
      connections: [{ id: 'a', password: 's1' }]
    })
    expect(buildSshExportPayload(config, [], 123).connections).toHaveLength(2)
  })

  it('writes an atomic private file that can be read as a Native-compatible payload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-ssh-export-'))
    directories.push(directory)
    const target = join(directory, 'nested', 'hosts.json')
    await writeSshExportFile(target, config, ['b'])
    const payload = JSON.parse(await readFile(target, 'utf8'))
    expect(payload).toMatchObject({
      schemaVersion: 1,
      source: 'ola-ssh',
      groups: [{ id: 'second' }],
      connections: [{ id: 'b', password: 's2' }]
    })
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  it('refuses symlink targets without changing their referents', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-ssh-export-'))
    directories.push(directory)
    const referent = join(directory, 'existing.json')
    const target = join(directory, 'link.json')
    await writeFile(referent, 'original')
    await symlink(referent, target)
    await expect(writeSshExportFile(target, config)).rejects.toThrow('SSH_EXPORT_UNSAFE_FILE')
    expect(await readFile(referent, 'utf8')).toBe('original')
  })
})
