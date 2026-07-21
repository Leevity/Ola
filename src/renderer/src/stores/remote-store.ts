import { create } from 'zustand'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import type {
  RemoteConnection,
  RemoteConnectionCreateRequest,
  RemoteConnectionListResult,
  RemoteConnectionTestResult,
  RemoteConnectionUpdateRequest,
  RemoteSession
} from '@renderer/lib/remote/remote-types'

export type RemoteClientStatus = {
  available: boolean
  command: string | null
  platform: string
  installHint: string | null
  installHintCode?: string | null
  error?: string
  websockifyAvailable?: boolean
}

type RemoteStore = {
  connections: RemoteConnection[]
  sessions: RemoteSession[]
  loadingConnections: boolean
  connectingConnectionId: string | null
  testingConnectionId: string | null
  rdpStatus: RemoteClientStatus | null
  vncStatus: RemoteClientStatus | null
  detecting: boolean
  loadConnections: () => Promise<void>
  loadSessions: () => Promise<void>
  createConnection: (input: RemoteConnectionCreateRequest) => Promise<RemoteConnection>
  updateConnection: (input: RemoteConnectionUpdateRequest) => Promise<RemoteConnection>
  testConnection: (id: string) => Promise<RemoteConnectionTestResult>
  deleteConnection: (id: string) => Promise<void>
  connect: (connectionId: string) => Promise<RemoteSession>
  disconnect: (sessionId: string) => Promise<void>
  detectClients: () => Promise<void>
}

export const useRemoteStore = create<RemoteStore>((set, get) => ({
  connections: [],
  sessions: [],
  loadingConnections: false,
  connectingConnectionId: null,
  testingConnectionId: null,
  rdpStatus: null,
  vncStatus: null,
  detecting: false,
  loadConnections: async () => {
    set({ loadingConnections: true })
    try {
      const result = (await ipcClient.invoke(
        IPC.REMOTE_CONNECTION_LIST
      )) as RemoteConnectionListResult
      set({ connections: result.connections })
    } finally {
      set({ loadingConnections: false })
    }
  },
  loadSessions: async () => {
    const result = (await ipcClient.invoke(IPC.REMOTE_SESSION_LIST)) as {
      sessions: RemoteSession[]
    }
    set({ sessions: result.sessions })
  },
  createConnection: async (input) => {
    const connection = (await ipcClient.invoke(
      IPC.REMOTE_CONNECTION_CREATE,
      input
    )) as RemoteConnection
    set({ connections: [...get().connections, connection] })
    return connection
  },
  updateConnection: async (input) => {
    const connection = (await ipcClient.invoke(
      IPC.REMOTE_CONNECTION_UPDATE,
      input
    )) as RemoteConnection
    set({
      connections: get().connections.map((item) => (item.id === connection.id ? connection : item))
    })
    return connection
  },
  testConnection: async (id) => {
    set({ testingConnectionId: id })
    try {
      return (await ipcClient.invoke(IPC.REMOTE_CONNECTION_TEST, {
        id
      })) as RemoteConnectionTestResult
    } finally {
      set({ testingConnectionId: null })
    }
  },
  deleteConnection: async (id) => {
    await ipcClient.invoke(IPC.REMOTE_CONNECTION_DELETE, { id })
    set({ connections: get().connections.filter((connection) => connection.id !== id) })
  },
  connect: async (connectionId) => {
    set({ connectingConnectionId: connectionId })
    try {
      const session = (await ipcClient.invoke(IPC.REMOTE_CONNECT, {
        connectionId
      })) as RemoteSession
      set({ sessions: [...get().sessions.filter((item) => item.id !== session.id), session] })
      await get().loadConnections()
      return session
    } finally {
      set({ connectingConnectionId: null })
    }
  },
  disconnect: async (sessionId) => {
    const result = (await ipcClient.invoke(IPC.REMOTE_DISCONNECT, { sessionId })) as {
      session: RemoteSession | null
    }
    if (!result.session) return
    set({
      sessions: get().sessions.map((session) =>
        session.id === result.session?.id ? result.session : session
      )
    })
  },
  detectClients: async () => {
    set({ detecting: true })
    try {
      const [rdpStatus, vncStatus] = await Promise.all([
        ipcClient.invoke(IPC.REMOTE_RDP_DETECT) as Promise<RemoteClientStatus>,
        ipcClient.invoke(IPC.REMOTE_VNC_DETECT) as Promise<RemoteClientStatus>
      ])
      set({ rdpStatus, vncStatus })
    } finally {
      set({ detecting: false })
    }
  }
}))
