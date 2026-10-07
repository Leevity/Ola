import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../../src/renderer/src/lib/ipc/ipc-client', () => ({ ipcClient: { invoke } }))

import { createIpcStateStorage } from '../../src/renderer/src/lib/ipc/ipc-state-storage'

describe('IPC state storage write status', () => {
  afterEach(() => invoke.mockReset())

  it('reports the real write result and retries an unchanged value after failure', async () => {
    const statuses: string[] = []
    const storage = createIpcStateStorage({
      getChannel: 'settings:get',
      setChannel: 'settings:set',
      onWriteStatus: ({ status }) => statuses.push(status)
    })
    invoke.mockRejectedValueOnce(new Error('disk unavailable'))
    await storage.setItem('ola-settings', '{"state":{"theme":"dark"}}')
    expect(statuses).toEqual(['saving', 'failed'])

    invoke.mockResolvedValueOnce({ success: true })
    await storage.setItem('ola-settings', '{"state":{"theme":"dark"}}')
    expect(statuses).toEqual(['saving', 'failed', 'saving', 'saved'])
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('does not report an earlier write as saved while a newer value is pending', async () => {
    const statuses: string[] = []
    let resolveFirst: ((value: unknown) => void) | undefined
    const firstResponse = new Promise<unknown>((resolve) => {
      resolveFirst = resolve
    })
    invoke.mockReturnValueOnce(firstResponse).mockResolvedValueOnce({ success: true })
    const storage = createIpcStateStorage({
      getChannel: 'settings:get',
      setChannel: 'settings:set',
      onWriteStatus: ({ status }) => statuses.push(status)
    })
    const first = storage.setItem('ola-settings', 'first')
    const second = storage.setItem('ola-settings', 'second')
    expect(statuses).toEqual(['saving', 'saving'])
    resolveFirst?.({ success: true })
    await Promise.all([first, second])
    expect(statuses).toEqual(['saving', 'saving', 'saved'])
  })

  it('treats an explicit IPC failure response as a failed save', async () => {
    const statuses: string[] = []
    invoke.mockResolvedValueOnce({ success: false, error: 'readonly' })
    const storage = createIpcStateStorage({
      getChannel: 'settings:get',
      setChannel: 'settings:set',
      onWriteStatus: ({ status }) => statuses.push(status)
    })
    await storage.setItem('ola-settings', 'value')
    expect(statuses).toEqual(['saving', 'failed'])
  })

  it('submits only changed settings fields and retries them after a failed write', async () => {
    const storage = createIpcStateStorage({
      getChannel: 'settings:get',
      setChannel: 'settings:set',
      mergeStateName: 'ola-settings'
    })
    invoke.mockResolvedValueOnce({ state: { theme: 'light', fontSize: 16 }, version: 29 })
    await storage.getItem('ola-settings')
    invoke.mockRejectedValueOnce(new Error('disk unavailable'))
    await storage.setItem(
      'ola-settings',
      JSON.stringify({ state: { theme: 'dark', fontSize: 16 }, version: 29 })
    )
    invoke.mockResolvedValueOnce({ success: true })
    await storage.setItem(
      'ola-settings',
      JSON.stringify({ state: { theme: 'dark', fontSize: 18 }, version: 29 })
    )
    expect(invoke).toHaveBeenLastCalledWith('settings:set', {
      key: 'ola-settings',
      patch: {
        set: { theme: 'dark', fontSize: 18 },
        remove: [],
        setPaths: [],
        removePaths: [],
        version: 29
      }
    })
  })

  it('sends nested object fields separately while keeping arrays atomic', async () => {
    const storage = createIpcStateStorage({
      getChannel: 'settings:get',
      setChannel: 'settings:set',
      mergeStateName: 'ola-settings'
    })
    invoke.mockResolvedValueOnce({
      state: { profile: { a: 1, b: 2, list: ['first'] } },
      version: 29
    })
    await storage.getItem('ola-settings')
    invoke.mockResolvedValueOnce({ success: true })
    await storage.setItem(
      'ola-settings',
      JSON.stringify({ state: { profile: { a: 3, list: ['first', 'second'] } }, version: 29 })
    )
    expect(invoke).toHaveBeenLastCalledWith('settings:set', {
      key: 'ola-settings',
      patch: {
        set: {},
        remove: [],
        setPaths: [
          { path: ['profile', 'a'], value: 3 },
          { path: ['profile', 'list'], value: ['first', 'second'] }
        ],
        removePaths: [['profile', 'b']],
        version: 29
      }
    })
  })
})
