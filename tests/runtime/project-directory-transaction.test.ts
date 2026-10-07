import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BusinessRepository } from '../../src/runtime/storage/business-repository'

type DirectoryRow = {
  working_folder: string | null
  ssh_connection_id: string | null
  updated_at: number
}

describe('project directory transaction', () => {
  it('updates linked sessions atomically and rolls back when a session update fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-project-directory-'))
    const databasePath = join(root, 'data.db')
    const repository = new BusinessRepository({ path: databasePath, mode: 'direct' })
    try {
      await repository.createProject({
        id: 'project-a',
        name: 'Project A',
        workspaceId: 'local-personal',
        createdAt: 1,
        updatedAt: 1,
        workingFolder: 'C:\\before',
        sshConnectionId: null
      })
      await repository.createSession({
        id: 'session-a',
        title: 'Session A',
        mode: 'chat',
        workspaceId: 'local-personal',
        projectId: 'project-a',
        createdAt: 1,
        updatedAt: 1,
        workingFolder: 'C:\\before'
      })

      await repository.updateProject<DirectoryRow>({
        id: 'project-a',
        workspaceId: 'local-personal',
        workingFolder: 'C:\\after',
        sshConnectionId: 'ssh-a',
        updatedAt: 2
      })
      expect(await repository.project<DirectoryRow>('project-a', 'local-personal')).toMatchObject({
        working_folder: 'C:\\after',
        ssh_connection_id: 'ssh-a'
      })
      expect(await repository.session<DirectoryRow>('session-a', 'local-personal')).toMatchObject({
        working_folder: 'C:\\after',
        ssh_connection_id: 'ssh-a'
      })

      const newer = await repository.updateProject<DirectoryRow>({
        id: 'project-a',
        workspaceId: 'local-personal',
        pinned: true,
        updatedAt: 2
      })
      expect(newer.updated_at).toBe(3)
      expect(
        (await repository.project<DirectoryRow>('project-a', 'local-personal'))?.updated_at
      ).toBe(3)

      const triggerDb = new DatabaseSync(databasePath)
      triggerDb.exec(`
        CREATE TRIGGER reject_session_directory BEFORE UPDATE OF working_folder ON sessions
        BEGIN SELECT RAISE(ABORT, 'DIRECTORY_DENIED'); END;
      `)
      triggerDb.close()

      await expect(
        repository.updateProject({
          id: 'project-a',
          workspaceId: 'local-personal',
          workingFolder: 'C:\\rejected',
          sshConnectionId: null,
          updatedAt: 3
        })
      ).rejects.toThrow('DIRECTORY_DENIED')
      expect(await repository.project<DirectoryRow>('project-a', 'local-personal')).toMatchObject({
        working_folder: 'C:\\after',
        ssh_connection_id: 'ssh-a'
      })
      expect(await repository.session<DirectoryRow>('session-a', 'local-personal')).toMatchObject({
        working_folder: 'C:\\after',
        ssh_connection_id: 'ssh-a'
      })
    } finally {
      await repository.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
