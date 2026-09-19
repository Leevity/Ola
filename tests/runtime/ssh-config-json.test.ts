import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeSshConfigDocument,
  readSshConfigDocument,
  mutateSshConfigFile,
  withSshConfigMutation,
  patchSshConnection,
  patchSshGroup
} from '../../src/main/ssh/ssh-config-json'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('TS SSH configuration reader', () => {
  it('reads only the SSH node and preserves the legacy shape and deduplication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-ssh-config-json-'))
    directories.push(directory)
    const path = join(directory, '.ola.json')
    await writeFile(
      path,
      JSON.stringify({
        otherSettings: { preserve: true },
        ssh: {
          groups: [
            { id: 'group-a', name: 'Group A', sortOrder: 2, createdAt: 1, updatedAt: 2 },
            { id: 'group-a', name: 'Duplicate', createdAt: 3 }
          ],
          connections: [
            {
              id: 'host-a',
              groupId: 'group-a',
              name: 'Host A',
              host: 'example.invalid',
              username: 'alice',
              authType: 'agent',
              password: 'secret',
              port: 2222,
              createdAt: 4,
              updatedAt: 5
            }
          ]
        }
      })
    )
    const result = normalizeSshConfigDocument(await readSshConfigDocument(path))
    expect(result.groups).toEqual([
      { id: 'group-a', name: 'Group A', sortOrder: 2, createdAt: 1, updatedAt: 2 }
    ])
    expect(result.connections).toMatchObject([
      {
        id: 'host-a',
        groupId: 'group-a',
        host: 'example.invalid',
        username: 'alice',
        authType: 'agent',
        password: 'secret',
        port: 2222,
        keepAliveInterval: 60
      }
    ])
  })

  it('keeps missing and corrupt files empty and rejects invalid numeric fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-ssh-config-json-'))
    directories.push(directory)
    const path = join(directory, '.ola.json')
    expect(normalizeSshConfigDocument(await readSshConfigDocument(path))).toEqual({
      groups: [],
      connections: []
    })
    await writeFile(path, '{broken')
    expect(normalizeSshConfigDocument(await readSshConfigDocument(path))).toEqual({
      groups: [],
      connections: []
    })
    expect(
      normalizeSshConfigDocument({
        connections: [
          {
            id: 'host',
            name: 'Host',
            host: 'example.invalid',
            username: 'alice',
            port: 22.5,
            keepAliveInterval: 1e100,
            createdAt: 1,
            updatedAt: 2
          }
        ]
      }).connections[0]
    ).toMatchObject({ port: 22, keepAliveInterval: 60 })
  })

  it('writes SSH changes atomically without replacing unrelated root settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-ssh-config-write-'))
    directories.push(directory)
    const path = join(directory, '.ola.json')
    await writeFile(path, JSON.stringify({ theme: 'dark', ssh: { groups: [], connections: [] } }))
    await Promise.all([
      mutateSshConfigFile(path, (current) => ({
        ...current,
        groups: [{ id: 'group', name: 'Group', sortOrder: 0, createdAt: 1, updatedAt: 1 }]
      })),
      mutateSshConfigFile(path, (current) => ({
        ...current,
        connections: [
          {
            id: 'host',
            groupId: 'group',
            name: 'Host',
            host: 'example.invalid',
            port: 22,
            username: 'alice',
            authType: 'password',
            password: 'secret',
            privateKeyPath: null,
            passphrase: null,
            startupCommand: null,
            defaultDirectory: null,
            proxyJump: null,
            keepAliveInterval: 60,
            sortOrder: 0,
            lastConnectedAt: null,
            createdAt: 2,
            updatedAt: 2
          }
        ]
      }))
    ])
    const root = JSON.parse(await readFile(path, 'utf8'))
    expect(root.theme).toBe('dark')
    expect(root.ssh.groups).toHaveLength(1)
    expect(root.ssh.connections).toMatchObject([{ id: 'host', password: 'secret' }])
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('creates a private workspace directory on first team configuration write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-ssh-team-config-'))
    directories.push(directory)
    const path = join(directory, 'workspaces', 'team-hash', 'ssh.json')
    await mutateSshConfigFile(path, (current) => ({
      ...current,
      groups: [{ id: 'team-group', name: 'Team', sortOrder: 0, createdAt: 1, updatedAt: 1 }]
    }))
    expect(normalizeSshConfigDocument(await readSshConfigDocument(path)).groups).toMatchObject([
      { id: 'team-group' }
    ])
    if (process.platform !== 'win32')
      expect((await stat(join(directory, 'workspaces', 'team-hash'))).mode & 0o777).toBe(0o700)
  })

  it('does not replace a configuration after authorization is revoked during mutation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-ssh-config-revoked-'))
    directories.push(directory)
    const path = join(directory, '.ola.json')
    const original = JSON.stringify({ ssh: { groups: [], connections: [] } })
    await writeFile(path, original)
    let authorized = true
    await expect(
      mutateSshConfigFile(
        path,
        (current) => {
          authorized = false
          return current
        },
        () => authorized
      )
    ).rejects.toThrow('SSH_WORKSPACE_REVOKED')
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('refuses corrupt or symlink targets without overwriting them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-ssh-config-write-'))
    directories.push(directory)
    const path = join(directory, '.ola.json')
    await writeFile(path, '{broken')
    await expect(mutateSshConfigFile(path, (current) => current)).rejects.toThrow(
      'SSH_CONFIG_CORRUPT'
    )
    expect(await readFile(path, 'utf8')).toBe('{broken')
    const linked = join(directory, 'linked.json')
    await symlink(path, linked)
    expect(await readSshConfigDocument(linked)).toBeNull()
    await expect(mutateSshConfigFile(linked, (current) => current)).rejects.toThrow(
      'SSH_CONFIG_UNSAFE_FILE'
    )
  })

  it('serializes Native import with TS mutations through one Main queue', async () => {
    let release: (() => void) | undefined
    const pending = withSshConfigMutation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const directory = await mkdtemp(join(tmpdir(), 'ola-ssh-config-write-'))
    directories.push(directory)
    const path = join(directory, '.ola.json')
    let finished = false
    const write = mutateSshConfigFile(path, (current) => current).then(() => {
      finished = true
    })
    await Promise.resolve()
    expect(finished).toBe(false)
    release?.()
    await pending
    await write
    expect(finished).toBe(true)
  })

  it('applies only supported patch fields and never changes connection identity or creation time', () => {
    const group = { id: 'group', name: 'Original', sortOrder: 0, createdAt: 1, updatedAt: 1 }
    expect(patchSshGroup(group, { name: 'Changed', updatedAt: 3 })).toMatchObject({
      id: 'group',
      name: 'Changed',
      createdAt: 1,
      updatedAt: 3
    })
    expect(() => patchSshGroup(group, { name: '' })).toThrow('INVALID_SSH_GROUP_NAME')
    const connection = normalizeSshConfigDocument({
      connections: [
        {
          id: 'host',
          name: 'Host',
          host: 'example.invalid',
          username: 'alice',
          createdAt: 1,
          updatedAt: 2
        }
      ]
    }).connections[0]
    expect(
      patchSshConnection(connection, {
        groupId: 'group',
        port: 2222,
        createdAt: 999,
        updatedAt: 4
      })
    ).toMatchObject({ id: 'host', createdAt: 1, groupId: 'group', port: 2222, updatedAt: 4 })
    expect(() => patchSshConnection(connection, { host: '' })).toThrow('INVALID_SSH_host')
    expect(() => patchSshConnection(connection, { port: 22.5 })).toThrow('INVALID_SSH_port')
    expect(connection.host).toBe('example.invalid')
  })
})
