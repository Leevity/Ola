import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../../src/renderer/src/lib/ipc/messagepack-ipc-client', () => ({
  invokeMessagePackBinary: fixture.invoke,
  invokeMessagePack: fixture.invoke
}))
vi.mock('../../src/renderer/src/stores/agent-store', () => ({
  useAgentStore: { getState: () => ({}) }
}))

import { useChatStore } from '../../src/renderer/src/stores/chat-store'
import { useWorkspaceStore } from '../../src/renderer/src/stores/workspace-store'
import {
  DB_PROJECTS_CREATE_MSGPACK_CHANNEL,
  DB_PROJECTS_UPDATE_MSGPACK_CHANNEL
} from '../../src/shared/messagepack/binary-ipc'

describe('project creation persistence', () => {
  beforeEach(() => {
    fixture.invoke.mockReset()
    useWorkspaceStore.setState({ activeWorkspaceId: 'local-personal' })
    useChatStore.setState({ projects: [], activeProjectId: null })
  })

  it('does not add a phantom project when the database rejects creation', async () => {
    fixture.invoke.mockRejectedValueOnce(new Error('disk full'))

    await expect(
      useChatStore.getState().createProject({ name: 'Unsaved project' })
    ).rejects.toThrow('disk full')
    expect(fixture.invoke).toHaveBeenCalledWith(
      DB_PROJECTS_CREATE_MSGPACK_CHANNEL,
      expect.objectContaining({ name: 'Unsaved project' })
    )
    expect(useChatStore.getState().projects).toEqual([])
    expect(useChatStore.getState().activeProjectId).toBeNull()
    expect(fixture.invoke).toHaveBeenCalledTimes(1)
  })

  it('deduplicates its own project broadcast and ignores another workspace', async () => {
    const row = {
      id: 'project-persisted',
      name: 'Saved project',
      created_at: 1,
      updated_at: 1,
      working_folder: null,
      ssh_connection_id: null,
      plugin_id: null,
      pinned: 0,
      workspace_id: 'local-personal'
    }
    fixture.invoke.mockImplementationOnce(async () => {
      useChatStore.getState().upsertProjectFromSync(row)
      return row
    })

    await expect(useChatStore.getState().createProject({ name: row.name })).resolves.toBe(row.id)
    expect(useChatStore.getState().projects.map((project) => project.id)).toEqual([row.id])

    useChatStore.getState().upsertProjectFromSync({
      ...row,
      id: 'foreign-project',
      workspace_id: 'team-other'
    })
    expect(useChatStore.getState().projects.map((project) => project.id)).toEqual([row.id])
  })

  it('keeps the old name when project rename fails to persist', async () => {
    const row = {
      id: 'project-rename',
      name: 'Original project',
      created_at: 1,
      updated_at: 1,
      working_folder: null,
      ssh_connection_id: null,
      plugin_id: null,
      pinned: 0,
      workspace_id: 'local-personal'
    }
    useChatStore.getState().upsertProjectFromSync(row)
    fixture.invoke.mockRejectedValueOnce(new Error('write denied'))

    await expect(useChatStore.getState().renameProject(row.id, 'Unsaved name')).rejects.toThrow(
      'write denied'
    )
    expect(fixture.invoke).toHaveBeenCalledWith(
      DB_PROJECTS_UPDATE_MSGPACK_CHANNEL,
      expect.objectContaining({
        id: row.id,
        patch: expect.objectContaining({ name: 'Unsaved name' })
      })
    )
    expect(useChatStore.getState().projects[0].name).toBe(row.name)
  })

  it('uses the committed project row after a successful rename', async () => {
    const row = {
      id: 'project-rename',
      name: 'Original project',
      created_at: 1,
      updated_at: 1,
      working_folder: null,
      ssh_connection_id: null,
      plugin_id: null,
      pinned: 0,
      workspace_id: 'local-personal'
    }
    useChatStore.getState().upsertProjectFromSync(row)
    fixture.invoke.mockResolvedValueOnce({
      success: true,
      project: { ...row, name: 'Persisted name', updated_at: 2 }
    })

    await useChatStore.getState().renameProject(row.id, 'Persisted name')
    expect(useChatStore.getState().projects[0].name).toBe('Persisted name')
    expect(useChatStore.getState().projects[0].updatedAt).toBe(2)
  })

  it('ignores an older project update that arrives after a newer window update', async () => {
    const row = {
      id: 'project-concurrent',
      name: 'Original',
      created_at: 1,
      updated_at: 1,
      working_folder: null,
      ssh_connection_id: null,
      plugin_id: null,
      pinned: 0,
      workspace_id: 'local-personal'
    }
    useChatStore.getState().upsertProjectFromSync(row)
    fixture.invoke.mockImplementationOnce(async () => {
      useChatStore.getState().upsertProjectFromSync({
        ...row,
        name: 'Newer window name',
        updated_at: 3
      })
      return { success: true, project: { ...row, name: 'Older rename', updated_at: 2 } }
    })

    await useChatStore.getState().renameProject(row.id, 'Older rename')
    expect(useChatStore.getState().projects[0]).toMatchObject({
      name: 'Newer window name',
      updatedAt: 3
    })
  })

  it('does not overwrite a newer project event with the create response', async () => {
    const row = {
      id: 'project-create-concurrent',
      name: 'Initial name',
      created_at: 1,
      updated_at: 1,
      working_folder: null,
      ssh_connection_id: null,
      plugin_id: null,
      pinned: 0,
      workspace_id: 'local-personal'
    }
    fixture.invoke.mockImplementationOnce(async () => {
      useChatStore.getState().upsertProjectFromSync({
        ...row,
        name: 'Renamed elsewhere',
        updated_at: 2
      })
      return row
    })

    await expect(useChatStore.getState().createProject({ name: row.name })).resolves.toBe(row.id)
    expect(useChatStore.getState().projects[0]).toMatchObject({
      name: 'Renamed elsewhere',
      updatedAt: 2
    })
  })

  it('leaves the project folder unchanged when its transaction is rejected', async () => {
    const row = {
      id: 'project-directory',
      name: 'Directory project',
      created_at: 1,
      updated_at: 1,
      working_folder: 'C:\\before',
      ssh_connection_id: null,
      plugin_id: null,
      pinned: 0,
      workspace_id: 'local-personal'
    }
    useChatStore.getState().upsertProjectFromSync(row)
    fixture.invoke.mockRejectedValueOnce(new Error('DIRECTORY_DENIED'))

    await expect(
      useChatStore.getState().updateProjectDirectory(row.id, {
        workingFolder: 'C:\\rejected',
        sshConnectionId: null
      })
    ).resolves.toBe(false)
    expect(useChatStore.getState().projects[0].workingFolder).toBe('C:\\before')
  })

  it('leaves the pin unchanged when storage rejects it', async () => {
    const row = {
      id: 'project-pin',
      name: 'Pinned project',
      created_at: 1,
      updated_at: 1,
      working_folder: null,
      ssh_connection_id: null,
      plugin_id: null,
      pinned: 0,
      workspace_id: 'local-personal'
    }
    useChatStore.getState().upsertProjectFromSync(row)
    fixture.invoke.mockRejectedValueOnce(new Error('PIN_DENIED'))

    await expect(useChatStore.getState().togglePinProject(row.id)).resolves.toBe(false)
    expect(useChatStore.getState().projects[0].pinned).toBe(false)
  })
})
