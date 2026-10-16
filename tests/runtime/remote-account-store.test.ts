import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload
} from '../../src/shared/messagepack/binary-ipc'

const values = new Map<string, string>()
const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const storageListeners: Array<(event: StorageEvent) => void> = []
const testLocalStorage: Storage = {
  get length() {
    return values.size
  },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => values.delete(key),
  setItem: (key, value) => values.set(key, value)
}
let invokeHandler: (...args: unknown[]) => Promise<unknown> = async () => {
  throw new Error('credential revoked')
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: testLocalStorage,
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === 'storage') storageListeners.push(listener)
      },
      ola: {
        ipc: {
          invoke: async (...args: unknown[]) => await invokeHandler(...args)
        }
      }
    }
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: testLocalStorage
  })
})

afterAll(() => {
  if (previousLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', previousLocalStorage)
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

describe('remote account workspace lifecycle', () => {
  it('rehydrates the shared account when another window changes identity', async () => {
    const { useWorkspaceStore } = await import('../../src/renderer/src/stores/workspace-store')
    const { useRemoteAccountStore } =
      await import('../../src/renderer/src/stores/remote-account-store')
    invokeHandler = async (_channel, rawRequest) => {
      const request = decodeMessagePackPayload<{ operation: string }>(rawRequest as Uint8Array)
      if (request.operation === 'hydrate') {
        return encodeMessagePackPayload({
          account: { id: 'new-account', email: 'new@example.test' },
          device: {
            id: 'new-device',
            accountId: 'new-account',
            deviceName: 'New device',
            platform: 'test',
            isOnline: true,
            createdAt: new Date(0).toISOString()
          }
        })
      }
      if (request.operation === 'device-list') return encodeMessagePackPayload({ devices: [] })
      if (request.operation === 'mesh-node-list') return encodeMessagePackPayload({ nodes: [] })
      if (request.operation === 'workspace-list')
        return encodeMessagePackPayload({ workspaces: [] })
      throw new Error(`unexpected remote account operation: ${request.operation}`)
    }
    useWorkspaceStore.setState({
      activeWorkspaceId: 'old-team',
      olaWorkspaces: [{ id: 'old-team', kind: 'ola-team', name: 'Old Team' }],
      resourcesByWorkspace: {}
    })
    useRemoteAccountStore.setState({
      apiBaseUrl: 'https://old.example.test',
      token: 'main-process',
      account: { id: 'old-account', email: 'old@example.test' },
      device: {
        id: 'old-device',
        accountId: 'old-account',
        deviceName: 'Old device',
        platform: 'test',
        isOnline: true,
        createdAt: new Date(0).toISOString()
      }
    })
    testLocalStorage.setItem(
      'ola.remote.account',
      JSON.stringify({
        apiBaseUrl: 'http://127.0.0.1:17300',
        account: { id: 'new-account', email: 'new@example.test' },
        device: {
          id: 'new-device',
          accountId: 'new-account',
          deviceName: 'New device',
          platform: 'test',
          isOnline: true,
          createdAt: new Date(0).toISOString()
        }
      })
    )

    for (const listener of storageListeners) {
      listener({ key: 'ola.remote.account' } as StorageEvent)
    }

    await vi.waitFor(() => {
      expect(useRemoteAccountStore.getState()).toMatchObject({
        apiBaseUrl: 'http://127.0.0.1:17300',
        account: { id: 'new-account', email: 'new@example.test' },
        device: { id: 'new-device', accountId: 'new-account' }
      })
    })
    expect(useWorkspaceStore.getState()).toMatchObject({
      activeWorkspaceId: 'local-personal',
      olaWorkspaces: []
    })
    invokeHandler = async () => {
      throw new Error('credential revoked')
    }
  })

  it('requests a task.execute ticket and signs a task request for an online mobile node', async () => {
    const { useRemoteAccountStore } =
      await import('../../src/renderer/src/stores/remote-account-store')
    const desktopDevice = {
      id: 'desktop-device',
      accountId: 'account-a',
      deviceName: 'Ola Desktop',
      platform: 'macos',
      isOnline: true,
      createdAt: new Date(0).toISOString()
    }
    const mobileDevice = {
      id: 'mobile-device',
      accountId: 'account-a',
      deviceName: 'Test Phone',
      platform: 'android',
      isOnline: true,
      createdAt: new Date(0).toISOString()
    }
    const published: Array<Record<string, unknown>> = []
    const operations: string[] = []
    let desktopManifestRegistered = false
    useRemoteAccountStore.setState({
      apiBaseUrl: 'https://ola.example.test',
      token: 'main-process',
      account: { id: 'account-a', email: 'owner@example.test' },
      device: desktopDevice,
      devices: [],
      meshNodes: []
    })
    invokeHandler = async (_channel, rawRequest) => {
      const request = decodeMessagePackPayload<{
        apiBaseUrl: string
        operation: string
        payload: Record<string, unknown>
      }>(rawRequest as Uint8Array)
      operations.push(request.operation)
      if (request.operation === 'device-list') {
        return encodeMessagePackPayload({ devices: [desktopDevice, mobileDevice] })
      }
      if (request.operation === 'mesh-node-list') {
        return encodeMessagePackPayload({
          nodes: [
            {
              nodeId: 'node-desktop-device',
              deviceId: 'desktop-device',
              platform: 'macos',
              capabilities: desktopManifestRegistered
                ? [{ id: 'mesh.event.receive', risk: 'low', version: '1' }]
                : []
            },
            {
              nodeId: 'node-mobile-device',
              deviceId: 'mobile-device',
              platform: 'android',
              capabilities: [{ id: 'task.execute', risk: 'medium', version: '1' }]
            }
          ]
        })
      }
      if (request.operation === 'mesh-node-register') {
        desktopManifestRegistered = true
        return encodeMessagePackPayload({ node: { nodeId: 'node-desktop-device' } })
      }
      if (request.operation === 'mesh-capability-ticket') {
        expect(request.apiBaseUrl).toBe('https://ola.example.test')
        expect(request.payload).toMatchObject({
          subjectNodeId: 'node-desktop-device',
          targetNodeId: 'node-mobile-device',
          capabilities: ['task.execute']
        })
        return encodeMessagePackPayload({ ticket: 'server-issued-ticket' })
      }
      if (request.operation === 'mesh-event-publish') {
        published.push(request.payload)
        return encodeMessagePackPayload({ event: { cursor: 42 } })
      }
      throw new Error(`unexpected remote account operation: ${request.operation}`)
    }

    try {
      const result = await useRemoteAccountStore
        .getState()
        .sendMeshTask('node-mobile-device', '  Summarize the current project  ')
      expect(operations).toEqual([
        expect.stringMatching(/^(device-list|mesh-node-list)$/),
        expect.stringMatching(/^(device-list|mesh-node-list)$/),
        'mesh-node-register',
        expect.stringMatching(/^(device-list|mesh-node-list)$/),
        expect.stringMatching(/^(device-list|mesh-node-list)$/),
        'mesh-capability-ticket',
        'mesh-event-publish'
      ])
      expect(result).toMatchObject({
        taskId: expect.stringMatching(/^task-[0-9a-f-]{36}$/),
        eventId: expect.stringMatching(/^event-[0-9a-f-]{36}$/),
        sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        targetNodeId: 'node-mobile-device'
      })
      expect(published).toHaveLength(1)
      expect(published[0]).toMatchObject({
        ticket: 'server-issued-ticket',
        subjectNodeId: 'node-desktop-device',
        targetNodeId: 'node-mobile-device',
        sequence: 1,
        type: 'task.requested',
        payload: {
          task_id: result.taskId,
          task_text: 'Summarize the current project'
        }
      })
    } finally {
      invokeHandler = async () => {
        throw new Error('credential revoked')
      }
    }
  })

  it('does not request a Mesh ticket for an offline mobile device', async () => {
    const { useRemoteAccountStore } =
      await import('../../src/renderer/src/stores/remote-account-store')
    let ticketRequests = 0
    useRemoteAccountStore.setState({
      apiBaseUrl: 'https://ola.example.test',
      token: 'main-process',
      account: { id: 'account-a', email: 'owner@example.test' },
      device: {
        id: 'desktop-device',
        accountId: 'account-a',
        deviceName: 'Ola Desktop',
        platform: 'macos',
        isOnline: true,
        createdAt: new Date(0).toISOString()
      },
      devices: [],
      meshNodes: []
    })
    invokeHandler = async (_channel, rawRequest) => {
      const request = decodeMessagePackPayload<{ operation: string }>(rawRequest as Uint8Array)
      if (request.operation === 'device-list') {
        return encodeMessagePackPayload({
          devices: [
            {
              id: 'mobile-device',
              accountId: 'account-a',
              deviceName: 'Phone',
              platform: 'android',
              isOnline: false,
              createdAt: new Date(0).toISOString()
            }
          ]
        })
      }
      if (request.operation === 'mesh-node-list') {
        return encodeMessagePackPayload({
          nodes: [
            {
              nodeId: 'node-mobile-device',
              deviceId: 'mobile-device',
              platform: 'android',
              capabilities: [{ id: 'task.execute', risk: 'medium', version: '1' }]
            }
          ]
        })
      }
      if (request.operation === 'mesh-capability-ticket') ticketRequests += 1
      return encodeMessagePackPayload({ ticket: 'unexpected-ticket' })
    }

    try {
      await expect(
        useRemoteAccountStore.getState().sendMeshTask('node-mobile-device', 'Do a task')
      ).rejects.toThrow('offline')
      expect(ticketRequests).toBe(0)
    } finally {
      invokeHandler = async () => {
        throw new Error('credential revoked')
      }
    }
  })

  it('does not dispatch when the desktop receipt capability cannot be registered', async () => {
    const { useRemoteAccountStore } =
      await import('../../src/renderer/src/stores/remote-account-store')
    const desktopDevice = {
      id: 'desktop-device',
      accountId: 'account-a',
      deviceName: 'Ola Desktop',
      platform: 'macos',
      isOnline: true,
      createdAt: new Date(0).toISOString()
    }
    const mobileDevice = {
      id: 'mobile-device',
      accountId: 'account-a',
      deviceName: 'Phone',
      platform: 'android',
      isOnline: true,
      createdAt: new Date(0).toISOString()
    }
    let ticketRequests = 0
    let publishedEvents = 0
    useRemoteAccountStore.setState({
      apiBaseUrl: 'https://ola.example.test',
      token: 'main-process',
      account: { id: 'account-a', email: 'owner@example.test' },
      device: desktopDevice,
      devices: [],
      meshNodes: []
    })
    invokeHandler = async (_channel, rawRequest) => {
      const request = decodeMessagePackPayload<{ operation: string }>(rawRequest as Uint8Array)
      if (request.operation === 'device-list') {
        return encodeMessagePackPayload({ devices: [desktopDevice, mobileDevice] })
      }
      if (request.operation === 'mesh-node-list') {
        return encodeMessagePackPayload({
          nodes: [
            {
              nodeId: 'node-desktop-device',
              deviceId: desktopDevice.id,
              platform: 'macos',
              capabilities: []
            },
            {
              nodeId: 'node-mobile-device',
              deviceId: mobileDevice.id,
              platform: 'android',
              capabilities: [{ id: 'task.execute', risk: 'medium', version: '1' }]
            }
          ]
        })
      }
      if (request.operation === 'mesh-node-register') {
        return encodeMessagePackPayload({ node: { nodeId: 'node-desktop-device' } })
      }
      if (request.operation === 'mesh-capability-ticket') ticketRequests += 1
      if (request.operation === 'mesh-event-publish') publishedEvents += 1
      throw new Error(`unexpected remote account operation: ${request.operation}`)
    }

    try {
      await expect(
        useRemoteAccountStore.getState().sendMeshTask('node-mobile-device', 'Do a safe task')
      ).rejects.toThrow('receipt inbox is unavailable')
      expect(ticketRequests).toBe(0)
      expect(publishedEvents).toBe(0)
    } finally {
      invokeHandler = async () => {
        throw new Error('credential revoked')
      }
    }
  })

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
