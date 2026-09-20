import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  repository: {
    sshGroups: vi.fn(),
    createSshGroup: vi.fn(),
    updateSshGroup: vi.fn(),
    deleteSshGroup: vi.fn(),
    sshConnections: vi.fn(),
    sshConnection: vi.fn(),
    createSshConnection: vi.fn(),
    updateSshConnection: vi.fn(),
    deleteSshConnection: vi.fn()
  }
}))

vi.mock('../../src/main/db/business-write-canary', () => ({
  businessWriteCanary: () => state.repository,
  getTsDatabaseRouteGuard: () => {
    throw new Error('SSH DAO unexpectedly entered legacy route')
  }
}))

import {
  createSshConnection,
  createSshGroup,
  deleteSshConnection,
  deleteSshGroup,
  getSshConnection,
  listSshConnections,
  listSshGroups,
  updateSshConnection,
  updateSshGroup
} from '../../src/main/db/ssh-dao'

beforeEach(() => {
  for (const mock of Object.values(state.repository)) mock.mockReset()
  state.repository.sshGroups.mockResolvedValue([{ id: 'group-a' }])
  state.repository.sshConnections.mockResolvedValue([{ id: 'connection-a' }])
  state.repository.sshConnection.mockResolvedValue({ connection: { id: 'connection-a' } })
  state.repository.createSshGroup.mockResolvedValue({ success: true, changed: 1 })
  state.repository.updateSshGroup.mockResolvedValue({ success: true, changed: 1 })
  state.repository.deleteSshGroup.mockResolvedValue({ success: true, changed: 1 })
  state.repository.createSshConnection.mockResolvedValue({ success: true, changed: 1 })
  state.repository.updateSshConnection.mockResolvedValue({ success: true, changed: 1 })
  state.repository.deleteSshConnection.mockResolvedValue({ success: true, changed: 1 })
})

it('routes SSH groups and connections through the TS repository', async () => {
  await expect(listSshGroups()).resolves.toEqual([{ id: 'group-a' }])
  await createSshGroup({ id: 'group-a', name: 'Team', createdAt: 1, updatedAt: 1 })
  await updateSshGroup('group-a', { name: 'Updated' })
  await deleteSshGroup('group-a')

  await expect(listSshConnections()).resolves.toEqual([{ id: 'connection-a' }])
  await expect(getSshConnection('connection-a')).resolves.toEqual({ id: 'connection-a' })
  await createSshConnection({
    id: 'connection-a',
    name: 'Host',
    host: 'example.test',
    username: 'ola',
    createdAt: 1,
    updatedAt: 1
  })
  await updateSshConnection('connection-a', { host: 'updated.test' })
  await deleteSshConnection('connection-a')

  expect(state.repository.createSshGroup).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'group-a', name: 'Team' })
  )
  expect(state.repository.updateSshGroup).toHaveBeenCalledWith('group-a', { name: 'Updated' })
  expect(state.repository.deleteSshGroup).toHaveBeenCalledWith('group-a')
  expect(state.repository.createSshConnection).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'connection-a', host: 'example.test' })
  )
  expect(state.repository.updateSshConnection).toHaveBeenCalledWith('connection-a', {
    host: 'updated.test'
  })
  expect(state.repository.deleteSshConnection).toHaveBeenCalledWith('connection-a')
})
