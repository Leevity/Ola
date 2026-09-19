import { beforeAll, describe, expect, it } from 'vitest'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload
} from '../../src/shared/messagepack/binary-ipc'

const values = new Map<string, string>()
let invokeHandler: (...args: unknown[]) => Promise<unknown> = async () => {
  throw new Error('credential revoked')
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key)
      },
      ola: {
        ipc: {
          invoke: async (...args: unknown[]) => await invokeHandler(...args)
        }
      }
    }
  })
})

describe('remote account workspace lifecycle', () => {
  it('clears the managed directory when hydration fails', async () => {
    const { useWorkspaceStore } = await import('../../src/renderer/src/stores/workspace-store')
    const { useRemoteAccountStore } =
      await import('../../src/renderer/src/stores/remote-account-store')
    useWorkspaceStore.setState({
      activeWorkspaceId: 'team-a',
      olaWorkspaces: [{ id: 'team-a', kind: 'ola-team', name: 'Team A' }],
      resourcesByWorkspace: {
        'team-a': [
          {
            id: 'resource-a',
            workspaceId: 'team-a',
            providerName: 'Ola',
            model: 'model-a',
            enabled: true,
            isDefault: false
          }
        ]
      }
    })
    useRemoteAccountStore.setState({
      token: 'main-process',
      account: { id: 'old-account', email: 'old@example.test' },
      device: null
    })

    await useRemoteAccountStore.getState().hydrate()

    expect(useRemoteAccountStore.getState()).toMatchObject({
      token: null,
      account: null,
      device: null
    })
    expect(useWorkspaceStore.getState()).toMatchObject({
      activeWorkspaceId: 'local-personal',
      olaWorkspaces: [],
      resourcesByWorkspace: {}
    })
  })

  it('keeps an account-bound workspace directory available for local use while offline', async () => {
    const { useWorkspaceStore } = await import('../../src/renderer/src/stores/workspace-store')
    const { useRemoteAccountStore } =
      await import('../../src/renderer/src/stores/remote-account-store')
    invokeHandler = async (_channel, rawRequest) => {
      const request = decodeMessagePackPayload<{ operation: string }>(rawRequest as Uint8Array)
      if (request.operation === 'hydrate')
        return encodeMessagePackPayload({
          account: { id: 'offline-account', email: 'offline@example.test' },
          device: { id: 'offline-device' },
          offline: true
        })
      if (request.operation === 'workspace-list')
        return encodeMessagePackPayload({
          workspaces: [{ id: 'team-offline', kind: 'team', name: 'Offline Team' }],
          offline: true
        })
      throw new TypeError('network unavailable')
    }
    useWorkspaceStore.setState({
      activeWorkspaceId: 'local-personal',
      olaWorkspaces: [],
      resourcesByWorkspace: {}
    })
    await useRemoteAccountStore.getState().hydrate()
    expect(useRemoteAccountStore.getState().account?.id).toBe('offline-account')
    expect(useWorkspaceStore.getState().olaWorkspaces.map((workspace) => workspace.id)).toEqual([
      'team-offline'
    ])
    expect(useWorkspaceStore.getState().resourcesByWorkspace['team-offline']).toEqual([])
    expect(useRemoteAccountStore.getState().workspaceSyncState).toBe('unavailable')
  })

  it('removes stale teams when the directory explicitly rejects access', async () => {
    const { useWorkspaceStore } = await import('../../src/renderer/src/stores/workspace-store')
    const { useRemoteAccountStore } =
      await import('../../src/renderer/src/stores/remote-account-store')
    invokeHandler = async () => {
      throw new Error('Unauthorized')
    }
    useWorkspaceStore.setState({
      activeWorkspaceId: 'team-offline',
      olaWorkspaces: [{ id: 'team-offline', kind: 'ola-team', name: 'Offline Team' }],
      resourcesByWorkspace: {}
    })
    await expect(useRemoteAccountStore.getState().syncWorkspaces()).rejects.toThrow('Unauthorized')
    expect(useWorkspaceStore.getState()).toMatchObject({
      activeWorkspaceId: 'local-personal',
      olaWorkspaces: []
    })
  })

  it('ignores a workspace response that arrives after logout', async () => {
    const { useWorkspaceStore } = await import('../../src/renderer/src/stores/workspace-store')
    const { useRemoteAccountStore } =
      await import('../../src/renderer/src/stores/remote-account-store')
    let resolveWorkspaces: ((value: unknown) => void) | undefined
    let requestStarted = false
    invokeHandler = async () => {
      if (resolveWorkspaces) return {}
      requestStarted = true
      return await new Promise((resolve) => {
        resolveWorkspaces = resolve
      })
    }
    useWorkspaceStore.setState({
      activeWorkspaceId: 'local-personal',
      olaWorkspaces: [],
      resourcesByWorkspace: {}
    })
    useRemoteAccountStore.setState({
      token: 'main-process',
      account: { id: 'old-account', email: 'old@example.test' },
      device: null,
      workspaceSyncState: 'idle'
    })

    const sync = useRemoteAccountStore.getState().syncWorkspaces()
    await Promise.resolve()
    expect(requestStarted).toBe(true)
    useRemoteAccountStore.getState().logout()
    resolveWorkspaces!({
      workspaces: [{ id: 'team-a', kind: 'team', name: 'Team A' }]
    })
    await sync

    expect(useWorkspaceStore.getState()).toMatchObject({
      activeWorkspaceId: 'local-personal',
      olaWorkspaces: [],
      resourcesByWorkspace: {}
    })
  })
})
