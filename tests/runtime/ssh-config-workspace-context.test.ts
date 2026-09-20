import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withSshConfigMutation } from '../../src/main/ssh/ssh-config-json'

const mockedHome = vi.hoisted(() => ({ value: '' }))
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => mockedHome.value
}))

import {
  createSshGroup,
  currentSshWorkspaceId,
  forgetUnavailableSshConfigCaches,
  getSshConfigPath,
  initializeSshConfigCache,
  listSshGroups,
  withSshWorkspace
} from '../../src/main/ssh/ssh-config'

let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true })
  directory = undefined
})

describe('SSH configuration workspace context', () => {
  it('keeps concurrent asynchronous operations in distinct configuration paths', async () => {
    const personal = getSshConfigPath()
    const [teamA, teamB] = await Promise.all([
      withSshWorkspace('team-a', async () => {
        await Promise.resolve()
        expect(currentSshWorkspaceId()).toBe('team-a')
        return getSshConfigPath()
      }),
      withSshWorkspace('team-b', async () => {
        await Promise.resolve()
        expect(currentSshWorkspaceId()).toBe('team-b')
        return getSshConfigPath()
      })
    ])
    expect(teamA).not.toBe(teamB)
    expect(teamA).not.toBe(personal)
    expect(currentSshWorkspaceId()).toBe('local-personal')
    expect(() => withSshWorkspace(' team-a', () => undefined)).toThrow('INVALID_SSH_WORKSPACE')
  })

  it('keeps personal and team CRUD data in separate files and caches', async () => {
    directory = await mkdtemp(join(tmpdir(), 'ola-ssh-spaces-'))
    mockedHome.value = directory
    await initializeSshConfigCache()
    await createSshGroup({
      id: 'personal',
      name: 'Personal',
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1
    })
    const teamPath = await withSshWorkspace('team-a', async () => {
      await initializeSshConfigCache()
      expect(listSshGroups()).toEqual([])
      await createSshGroup({ id: 'team', name: 'Team', sortOrder: 0, createdAt: 2, updatedAt: 2 })
      return getSshConfigPath()
    })
    expect(listSshGroups().map((group) => group.id)).toEqual(['personal'])
    expect(JSON.parse(await readFile(getSshConfigPath(), 'utf8')).ssh.groups).toMatchObject([
      { id: 'personal' }
    ])
    expect(JSON.parse(await readFile(teamPath, 'utf8')).ssh.groups).toMatchObject([{ id: 'team' }])
  })

  it('evicts revoked team secrets without clearing the local personal cache', async () => {
    directory = await mkdtemp(join(tmpdir(), 'ola-ssh-revoke-'))
    mockedHome.value = directory
    await initializeSshConfigCache()
    await createSshGroup({ id: 'local', name: 'Local', sortOrder: 0, createdAt: 1, updatedAt: 1 })
    await withSshWorkspace('team-revoked', async () => {
      await initializeSshConfigCache()
      await createSshGroup({
        id: 'secret',
        name: 'Secret',
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1
      })
      expect(listSshGroups().map((group) => group.id)).toEqual(['secret'])
    })

    forgetUnavailableSshConfigCaches(new Set())
    expect(listSshGroups().map((group) => group.id)).toEqual(['local'])
    await withSshWorkspace('team-revoked', async () => {
      expect(listSshGroups()).toEqual([])
      await initializeSshConfigCache()
      expect(listSshGroups().map((group) => group.id)).toEqual(['secret'])
    })
  })

  it('rejects a queued team mutation after its workspace is revoked', async () => {
    directory = await mkdtemp(join(tmpdir(), 'ola-ssh-queued-revoke-'))
    mockedHome.value = directory
    await withSshWorkspace('team-queued', () => initializeSshConfigCache())
    let release!: () => void
    const blocker = withSshConfigMutation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const write = withSshWorkspace('team-queued', () =>
      createSshGroup({ id: 'late', name: 'Late', sortOrder: 0, createdAt: 1, updatedAt: 1 })
    )
    forgetUnavailableSshConfigCaches(new Set())
    await Promise.resolve()
    release()
    await blocker
    await expect(write).rejects.toThrow('SSH_WORKSPACE_REVOKED')
    expect(withSshWorkspace('team-queued', () => listSshGroups())).toEqual([])
  })
})
