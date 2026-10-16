import { create } from 'zustand'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { useWorkspaceStore } from './workspace-store'
import type { OlaModelResource, WorkspaceContext } from '@renderer/lib/workspace-context'

export type RemoteAccount = {
  id: string
  email: string
  displayName?: string
}

export type RemoteDevice = {
  id: string
  accountId: string
  deviceName: string
  platform: string
  fingerprint?: string
  isOnline: boolean
  lastSeen?: string
  createdAt: string
}

export type RemoteSessionAudit = {
  sessionId: string
  controllerDeviceId: string
  controlledDeviceId: string
  startedAt: string
  endedAt?: string
  disconnectReason?: string
  transport?: 'p2p' | 'turn'
  bytesTransferred: number
}

type RemoteWorkspaceResponse = {
  id: string
  kind: 'personal' | 'team'
  name: string
  role?: 'owner' | 'team_admin' | 'member'
  revision?: string
}

type RemoteModelResourceResponse = {
  id: string
  providerName?: string
  provider?: string
  model: string
  displayName?: string
  enabled?: boolean
  isDefault?: boolean
  supportsVision?: boolean
  supportsFunctionCall?: boolean
  category?: 'chat' | 'image' | 'embedding' | 'speech'
  revision?: string
}

export type MeshNode = {
  nodeId: string
  deviceId: string
  platform: 'android' | 'ios' | 'linux' | 'macos' | 'windows'
  runtime: string
  runtimeVersion: string
  publicKey: string
  capabilities: Array<{ id: string; risk: 'low' | 'medium' | 'high'; version?: string }>
  manifestVersion: number
  createdAt: string
  updatedAt: string
}

type PairingResponse = {
  code: string
  expiresAt: string
}

type ResolvedPairing = {
  deviceId: string
  accountId: string
  deviceName: string
  platform: string
  expiresAt: string
  sessionId: string
  sessionTicket: string
  iceServers: Array<{ urls: string; username?: string; credential?: string }>
}

export type MeshTaskDispatch = {
  eventId: string
  taskId: string
  sessionId: string
  targetNodeId: string
}

export type MeshTaskReceipt = {
  cursor: number
  eventId: string
  sessionId: string
  sequence: number
  type: string
  payload: { task_id: string; task_state: string; result_text?: string }
}

type RemoteAccountStore = {
  apiBaseUrl: string
  token: string | null
  account: RemoteAccount | null
  device: RemoteDevice | null
  devices: RemoteDevice[]
  meshNodes: MeshNode[]
  sessionAudits: RemoteSessionAudit[]
  pairingCode: PairingResponse | null
  resolvedPairing: ResolvedPairing | null
  allowRemoteControl: boolean
  loading: boolean
  workspaceSyncState: 'idle' | 'syncing' | 'unavailable'
  setApiBaseUrl: (apiBaseUrl: string) => void
  hydrate: () => Promise<void>
  register: (email: string, password: string) => Promise<void>
  login: (email: string, password: string) => Promise<void>
  startBrowserLogin: () => Promise<void>
  logout: () => void
  registerDevice: (deviceName: string) => Promise<void>
  issueDeviceSignalToken: () => Promise<string>
  loadDevices: () => Promise<void>
  loadMeshNodes: () => Promise<void>
  loadMeshTaskEvents: (after: number) => Promise<{ events: MeshTaskReceipt[]; nextCursor: number }>
  sendMeshTask: (targetNodeId: string, taskText: string) => Promise<MeshTaskDispatch>
  loadSessionAudits: () => Promise<void>
  heartbeatDevice: () => Promise<void>
  syncWorkspaces: () => Promise<void>
  setAllowRemoteControl: (allow: boolean) => Promise<void>
  createPairingCode: () => Promise<void>
  revokePairingCode: () => Promise<void>
  resolvePairingCode: (code: string) => Promise<ResolvedPairing>
  autoResolvePairing: (controlledDeviceId: string) => Promise<ResolvedPairing>
}

let workspaceSyncGeneration = 0
const STORAGE_KEY = 'ola.remote.account'
const DEFAULT_API_BASE_URL = 'https://lbxai.cn'
const LEGACY_DEFAULT_API_BASE_URL = 'http://100.64.0.6:7300'

function normalizeApiBaseUrl(value: string | null | undefined): string {
  const normalized = value?.trim().replace(/\/$/, '')
  if (!normalized || normalized === LEGACY_DEFAULT_API_BASE_URL) return DEFAULT_API_BASE_URL
  return normalized
}

function loadPersistedState(): Pick<
  RemoteAccountStore,
  'apiBaseUrl' | 'token' | 'account' | 'device'
> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { apiBaseUrl: DEFAULT_API_BASE_URL, token: null, account: null, device: null }
    const parsed = JSON.parse(raw) as Partial<
      Pick<RemoteAccountStore, 'apiBaseUrl' | 'token' | 'account' | 'device'>
    >
    return {
      apiBaseUrl: normalizeApiBaseUrl(parsed.apiBaseUrl),
      token: null,
      account: parsed.account ?? null,
      device: parsed.device ?? null
    }
  } catch {
    return { apiBaseUrl: DEFAULT_API_BASE_URL, token: null, account: null, device: null }
  }
}

function persist(
  state: Pick<RemoteAccountStore, 'apiBaseUrl' | 'token' | 'account' | 'device'>
): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, token: null }))
}

function createFingerprint(): string {
  const existing = window.localStorage.getItem(`${STORAGE_KEY}.fingerprint`)
  if (existing) return existing
  const fingerprint = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  window.localStorage.setItem(`${STORAGE_KEY}.fingerprint`, fingerprint)
  return fingerprint
}

async function request<T>(
  apiBaseUrl: string,
  operation: string,
  payload: Record<string, unknown> = {}
): Promise<T> {
  return ipcClient.invoke(IPC.REMOTE_ACCOUNT_INVOKE, {
    apiBaseUrl,
    operation,
    payload
  }) as Promise<T>
}

export const useRemoteAccountStore = create<RemoteAccountStore>((set, get) => {
  window.localStorage.removeItem(`${STORAGE_KEY}.modelConfig`)
  const persisted = loadPersistedState()
  return {
    ...persisted,
    devices: [],
    meshNodes: [],
    sessionAudits: [],
    pairingCode: null,
    resolvedPairing: null,
    allowRemoteControl: false,
    loading: false,
    workspaceSyncState: 'idle',
    setApiBaseUrl: (apiBaseUrl) => {
      workspaceSyncGeneration++
      useWorkspaceStore.getState().clearOlaState()
      const next = { ...get(), apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl) }
      set({ apiBaseUrl: next.apiBaseUrl, token: null, account: null, device: null })
      persist({
        apiBaseUrl: next.apiBaseUrl,
        token: next.token,
        account: next.account,
        device: next.device
      })
    },
    hydrate: async () => {
      const { apiBaseUrl } = get()
      try {
        const result = await request<{
          account: RemoteAccount
          device: RemoteDevice | null
          offline?: boolean
        }>(apiBaseUrl, 'hydrate')
        // A browser session is not the same as an Ola desktop token. When
        // OAuth has not completed yet, stop here instead of trying to
        // register a device and masking the real login state with a second
        // "Remote login is required" error.
        if (!result.account) {
          useWorkspaceStore.getState().clearOlaState()
          set({ token: null, account: null, device: null })
          return
        }
        set({ token: 'main-process', account: result.account, device: result.device })
        if (result.offline) {
          await get()
            .syncWorkspaces()
            .catch(() => undefined)
          return
        }
        if (!result.device) {
          await get().registerDevice('Ola Desktop')
        } else {
          await get().loadDevices()
          await get().loadMeshNodes()
          // Refresh the signed capability manifest after desktop upgrades so
          // existing nodes can receive newly supported Mesh receipts.
          try {
            await request(apiBaseUrl, 'mesh-node-register', { deviceId: result.device.id })
            await get().loadMeshNodes()
          } catch {
            // Keep the authenticated account usable if the Mesh control plane
            // is temporarily unavailable during desktop startup.
          }
        }
        await get()
          .syncWorkspaces()
          .catch(() => undefined)
      } catch {
        // A failed hydration can mean the desktop credential was revoked. Do
        // not leave a previous account's directory visible while a new login
        // is pending, and invalidate any requests that were started before it.
        workspaceSyncGeneration++
        useWorkspaceStore.getState().clearOlaState()
        set({ token: null, account: null, device: null })
      }
    },
    register: async (email, password) => {
      set({ loading: true })
      try {
        const { apiBaseUrl } = get()
        const result = await request<{ account: RemoteAccount }>(apiBaseUrl, 'register', {
          email,
          password
        })
        set({ token: 'main-process', account: result.account, device: null })
        persist({ apiBaseUrl, token: null, account: result.account, device: null })
        await get().registerDevice('Ola Desktop')
        await get()
          .syncWorkspaces()
          .catch(() => undefined)
      } finally {
        set({ loading: false })
      }
    },
    login: async (email, password) => {
      set({ loading: true })
      try {
        const { apiBaseUrl } = get()
        const result = await request<{ account: RemoteAccount }>(apiBaseUrl, 'login', {
          email,
          password
        })
        set({ token: 'main-process', account: result.account, device: null })
        persist({ apiBaseUrl, token: null, account: result.account, device: null })
        await get().registerDevice('Ola Desktop')
        await get()
          .syncWorkspaces()
          .catch(() => undefined)
      } finally {
        set({ loading: false })
      }
    },
    startBrowserLogin: async () => {
      const { apiBaseUrl } = get()
      set({ loading: true })
      try {
        await request(apiBaseUrl, 'oauth-start')
      } finally {
        set({ loading: false })
      }
    },
    logout: () => {
      workspaceSyncGeneration++
      const { apiBaseUrl } = get()
      const clearMainProcessSession = request(apiBaseUrl, 'logout').catch(() => undefined)
      set({
        token: null,
        account: null,
        device: null,
        devices: [],
        meshNodes: [],
        sessionAudits: [],
        pairingCode: null,
        resolvedPairing: null,
        allowRemoteControl: false
      })
      useWorkspaceStore.getState().clearOlaState()
      // Publish the shared-storage change only after the main process has
      // cleared its authoritative credential. Other windows hydrate from that
      // credential when they receive the storage event.
      void clearMainProcessSession.finally(() =>
        persist({ apiBaseUrl, token: null, account: null, device: null })
      )
    },
    registerDevice: async (deviceName) => {
      const { apiBaseUrl, token } = get()
      if (!token) throw new Error('Login is required before registering this device')
      set({ loading: true })
      try {
        const result = await request<{ device: RemoteDevice }>(apiBaseUrl, 'device-register', {
          deviceName: deviceName.trim() || window.navigator.userAgent,
          platform: window.navigator.platform || 'unknown',
          fingerprint: createFingerprint()
        })
        set({ device: result.device })
        persist({ apiBaseUrl, token, account: get().account, device: result.device })
        await request(apiBaseUrl, 'mesh-node-register', { deviceId: result.device.id })
        await get().loadDevices()
        await get().loadMeshNodes()
      } finally {
        set({ loading: false })
      }
    },
    issueDeviceSignalToken: async () => {
      const { apiBaseUrl, token, device } = get()
      if (!token || !device) throw new Error('Register this device before connecting signaling')
      const result = await request<{ token: string }>(apiBaseUrl, 'device-signaling-token', {
        deviceId: device.id
      })
      return result.token
    },
    loadDevices: async () => {
      const { apiBaseUrl, token } = get()
      if (!token) return
      const result = await request<{ devices: RemoteDevice[] }>(apiBaseUrl, 'device-list')
      set({ devices: result.devices })
    },
    loadMeshNodes: async () => {
      const { apiBaseUrl, token } = get()
      if (!token) return
      const result = await request<{ nodes: MeshNode[] }>(apiBaseUrl, 'mesh-node-list')
      set({ meshNodes: result.nodes })
    },
    loadMeshTaskEvents: async (after) => {
      const { apiBaseUrl, token, device } = get()
      if (!token || !device) return { events: [], nextCursor: after }
      return request(apiBaseUrl, 'mesh-event-list', {
        targetNodeId: `node-${device.id}`,
        after
      })
    },
    sendMeshTask: async (targetNodeId, taskText) => {
      const text = taskText.trim()
      const initial = get()
      if (!initial.token || !initial.device)
        throw new Error('Login and device registration are required')
      if (!targetNodeId.trim()) throw new Error('Choose a mobile Mesh node')
      if (!text || new TextEncoder().encode(text).byteLength > 12 * 1024) {
        throw new Error('Task text must be between 1 byte and 12 KiB')
      }

      await Promise.all([get().loadDevices(), get().loadMeshNodes()])
      let current = get()
      if (
        current.account?.id !== initial.account?.id ||
        current.device?.id !== initial.device.id ||
        current.apiBaseUrl !== initial.apiBaseUrl ||
        !current.token
      ) {
        throw new Error('Ola account changed before the task could be sent')
      }

      const target = current.meshNodes.find((node) => node.nodeId === targetNodeId)
      if (!target || !['android', 'ios'].includes(target.platform)) {
        throw new Error('The selected node is not an Ola Mobile device')
      }
      const subjectNodeId = `node-${current.device.id}`
      if (target.nodeId === subjectNodeId || target.deviceId === current.device.id) {
        throw new Error('A desktop cannot send a Mesh task to itself')
      }
      if (!target.capabilities.some((capability) => capability.id === 'task.execute')) {
        throw new Error('The selected mobile node cannot execute Agent tasks')
      }
      const targetDevice = current.devices.find((item) => item.id === target.deviceId)
      if (!targetDevice || targetDevice.accountId !== current.account?.id) {
        throw new Error('The selected mobile device does not belong to the active Ola account')
      }
      if (!targetDevice?.isOnline) throw new Error('The selected mobile device is offline')

      const desktopNode = current.meshNodes.find((node) => node.nodeId === subjectNodeId)
      if (!desktopNode?.capabilities.some((capability) => capability.id === 'mesh.event.receive')) {
        await request(current.apiBaseUrl, 'mesh-node-register', { deviceId: current.device.id })
        await Promise.all([get().loadDevices(), get().loadMeshNodes()])
        current = get()
        if (
          current.account?.id !== initial.account?.id ||
          current.device?.id !== initial.device.id ||
          current.apiBaseUrl !== initial.apiBaseUrl ||
          !current.token
        ) {
          throw new Error('Ola account changed before the task could be sent')
        }
        const refreshedDesktopNode = current.meshNodes.find((node) => node.nodeId === subjectNodeId)
        if (
          !refreshedDesktopNode?.capabilities.some(
            (capability) => capability.id === 'mesh.event.receive'
          )
        ) {
          throw new Error('Desktop Mesh receipt inbox is unavailable; refresh nodes and retry')
        }
        const refreshedTarget = current.meshNodes.find((node) => node.nodeId === targetNodeId)
        if (
          !refreshedTarget ||
          !['android', 'ios'].includes(refreshedTarget.platform) ||
          !refreshedTarget.capabilities.some((capability) => capability.id === 'task.execute')
        ) {
          throw new Error('The selected mobile node no longer supports Agent tasks')
        }
        const refreshedTargetDevice = current.devices.find(
          (item) => item.id === refreshedTarget.deviceId
        )
        if (!refreshedTargetDevice || refreshedTargetDevice.accountId !== current.account?.id) {
          throw new Error('The selected mobile device no longer belongs to the active Ola account')
        }
        if (!refreshedTargetDevice.isOnline)
          throw new Error('The selected mobile device is offline')
      }
      const sessionId = globalThis.crypto.randomUUID()
      const taskId = `task-${globalThis.crypto.randomUUID()}`
      const eventId = `event-${globalThis.crypto.randomUUID()}`
      const ticket = await request<{ ticket: string }>(
        current.apiBaseUrl,
        'mesh-capability-ticket',
        {
          subjectNodeId,
          targetNodeId,
          sessionId,
          capabilities: ['task.execute']
        }
      )
      await request(current.apiBaseUrl, 'mesh-event-publish', {
        ticket: ticket.ticket,
        eventId,
        subjectNodeId,
        targetNodeId,
        sessionId,
        sequence: 1,
        type: 'task.requested',
        payload: { task_id: taskId, task_text: text }
      })
      return { eventId, taskId, sessionId, targetNodeId }
    },
    loadSessionAudits: async () => {
      const { apiBaseUrl, token } = get()
      if (!token) return
      const result = await request<{ sessions: RemoteSessionAudit[] }>(apiBaseUrl, 'session-list')
      set({ sessionAudits: result.sessions })
    },
    heartbeatDevice: async () => {
      const { apiBaseUrl, token, device } = get()
      if (!token || !device) return
      const result = await request<{ device: RemoteDevice }>(apiBaseUrl, 'device-heartbeat', {
        deviceId: device.id
      })
      set({ device: result.device })
      await request(apiBaseUrl, 'mesh-node-heartbeat', { nodeId: `node-${device.id}` })
    },
    syncWorkspaces: async () => {
      const generation = ++workspaceSyncGeneration
      let directoryVerified = false
      const { apiBaseUrl, token, account } = get()
      const isCurrent = (): boolean =>
        generation === workspaceSyncGeneration &&
        get().account?.id === account?.id &&
        get().apiBaseUrl === apiBaseUrl &&
        !!get().token
      if (!token) {
        useWorkspaceStore.getState().clearOlaState()
        set({ workspaceSyncState: 'idle' })
        return
      }
      set({ workspaceSyncState: 'syncing' })
      try {
        const result = await request<{
          workspaces?: RemoteWorkspaceResponse[]
          offline?: boolean
        }>(apiBaseUrl, 'workspace-list')
        directoryVerified = true
        const workspaces: WorkspaceContext[] = (result.workspaces ?? []).map((workspace) => ({
          id: workspace.id,
          kind: workspace.kind === 'team' ? 'ola-team' : 'ola-personal',
          name: workspace.name,
          role: workspace.role,
          revision: workspace.revision
        }))
        if (!isCurrent()) return
        useWorkspaceStore.getState().replaceOlaWorkspaces(workspaces)
        if (result.offline) {
          const workspaceStore = useWorkspaceStore.getState()
          for (const workspace of workspaces) workspaceStore.setResources(workspace.id, [])
          set({ workspaceSyncState: 'unavailable' })
          return
        }
        const resourceEntries = await Promise.all(
          workspaces.map(async (workspace) => {
            const resources = await request<{ resources?: RemoteModelResourceResponse[] }>(
              apiBaseUrl,
              'workspace-model-resources',
              { workspaceId: workspace.id }
            )
            const normalized: OlaModelResource[] = (resources.resources ?? []).map((resource) => ({
              id: resource.id,
              workspaceId: workspace.id,
              providerName: resource.providerName ?? resource.provider ?? 'Ola',
              model: resource.model,
              displayName: resource.displayName,
              enabled: resource.enabled !== false,
              isDefault: resource.isDefault === true,
              supportsVision: resource.supportsVision,
              supportsFunctionCall: resource.supportsFunctionCall,
              category: resource.category,
              revision: resource.revision
            }))
            return [workspace.id, normalized] as const
          })
        )
        if (!isCurrent()) return
        const workspaceStore = useWorkspaceStore.getState()
        workspaceStore.replaceOlaWorkspaces(workspaces)
        for (const [workspaceId, resources] of resourceEntries) {
          workspaceStore.setResources(workspaceId, resources)
        }
        set({ workspaceSyncState: 'idle' })
      } catch (error) {
        if (!isCurrent()) return
        const workspace = useWorkspaceStore.getState()
        if (!directoryVerified) workspace.clearOlaState()
        for (const entry of workspace.olaWorkspaces) workspace.setResources(entry.id, [])
        set({ workspaceSyncState: 'unavailable' })
        throw error
      }
    },
    setAllowRemoteControl: async (allow) => {
      if (allow) {
        await get().createPairingCode()
        return
      }
      await get().revokePairingCode()
      set({ allowRemoteControl: false, pairingCode: null })
    },
    createPairingCode: async () => {
      const { apiBaseUrl, token, device } = get()
      if (!token) throw new Error('Login is required before creating a pairing code')
      if (!device) throw new Error('Register this device before creating a pairing code')
      const result = await request<PairingResponse>(apiBaseUrl, 'pairing-create', {
        deviceId: device.id
      })
      set({ pairingCode: result, allowRemoteControl: true })
    },
    revokePairingCode: async () => {
      const { apiBaseUrl, token, device } = get()
      if (!token || !device) return
      await request<{ success: boolean; revoked: number }>(apiBaseUrl, 'pairing-revoke', {
        deviceId: device.id
      })
    },
    resolvePairingCode: async (code) => {
      const { apiBaseUrl, token, device } = get()
      if (!token) throw new Error('Login is required before resolving a pairing code')
      if (!device) throw new Error('Register this device before resolving a pairing code')
      const sessionId = globalThis.crypto?.randomUUID?.() ?? `remote-${Date.now()}-${Math.random()}`
      const result = await request<ResolvedPairing>(apiBaseUrl, 'pairing-resolve', {
        code,
        deviceId: device.id,
        sessionId
      })
      set({ resolvedPairing: result })
      return result
    },
    autoResolvePairing: async (controlledDeviceId) => {
      const { apiBaseUrl, token, device } = get()
      if (!token || !device) throw new Error('Login and device registration are required')
      const sessionId = globalThis.crypto?.randomUUID?.() ?? `remote-${Date.now()}-${Math.random()}`
      const result = await request<ResolvedPairing>(apiBaseUrl, 'pairing-auto-resolve', {
        controllerDeviceId: device.id,
        controlledDeviceId,
        sessionId
      })
      set({ resolvedPairing: result })
      return result
    }
  }
})

// The primary workspace and the detached remote-control window have separate
// renderer stores but share Electron's default-session localStorage. Keep the
// visible account/device identity aligned when either window signs in, signs
// out, or changes the control-plane URL. Tokens remain in the main process.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return

    const persisted = loadPersistedState()
    const current = useRemoteAccountStore.getState()
    if (
      current.apiBaseUrl === persisted.apiBaseUrl &&
      current.account?.id === persisted.account?.id &&
      current.device?.id === persisted.device?.id
    ) {
      return
    }

    workspaceSyncGeneration++
    useWorkspaceStore.getState().clearOlaState()
    useRemoteAccountStore.setState({
      apiBaseUrl: persisted.apiBaseUrl,
      token: null,
      account: null,
      device: null,
      devices: [],
      meshNodes: [],
      sessionAudits: [],
      pairingCode: null,
      resolvedPairing: null,
      allowRemoteControl: false,
      workspaceSyncState: 'idle'
    })
    void useRemoteAccountStore.getState().hydrate()
  })
}
