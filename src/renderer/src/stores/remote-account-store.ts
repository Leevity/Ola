import { create } from 'zustand'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'

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

type RemoteAccountStore = {
  apiBaseUrl: string
  token: string | null
  account: RemoteAccount | null
  device: RemoteDevice | null
  devices: RemoteDevice[]
  sessionAudits: RemoteSessionAudit[]
  pairingCode: PairingResponse | null
  resolvedPairing: ResolvedPairing | null
  allowRemoteControl: boolean
  loading: boolean
  setApiBaseUrl: (apiBaseUrl: string) => void
  hydrate: () => Promise<void>
  register: (email: string, password: string) => Promise<void>
  login: (email: string, password: string) => Promise<void>
  logout: () => void
  registerDevice: (deviceName: string) => Promise<void>
  issueDeviceSignalToken: () => Promise<string>
  loadDevices: () => Promise<void>
  loadSessionAudits: () => Promise<void>
  heartbeatDevice: () => Promise<void>
  setAllowRemoteControl: (allow: boolean) => Promise<void>
  createPairingCode: () => Promise<void>
  revokePairingCode: () => Promise<void>
  resolvePairingCode: (code: string) => Promise<ResolvedPairing>
}

const STORAGE_KEY = 'ola.remote.account'
const DEFAULT_API_BASE_URL = 'http://127.0.0.1:7300'

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
      apiBaseUrl: parsed.apiBaseUrl || DEFAULT_API_BASE_URL,
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
  const persisted = loadPersistedState()
  return {
    ...persisted,
    devices: [],
    sessionAudits: [],
    pairingCode: null,
    resolvedPairing: null,
    allowRemoteControl: false,
    loading: false,
    setApiBaseUrl: (apiBaseUrl) => {
      const next = { ...get(), apiBaseUrl: apiBaseUrl.trim() || DEFAULT_API_BASE_URL }
      set({ apiBaseUrl: next.apiBaseUrl })
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
        const result = await request<{ account: RemoteAccount; device: RemoteDevice | null }>(
          apiBaseUrl,
          'hydrate'
        )
        set({ token: 'main-process', account: result.account, device: result.device })
      } catch {
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
      } finally {
        set({ loading: false })
      }
    },
    logout: () => {
      const { apiBaseUrl } = get()
      void request(apiBaseUrl, 'logout').catch(() => undefined)
      set({
        token: null,
        account: null,
        device: null,
        devices: [],
        sessionAudits: [],
        pairingCode: null,
        resolvedPairing: null,
        allowRemoteControl: false
      })
      persist({ apiBaseUrl, token: null, account: null, device: null })
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
        await get().loadDevices()
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
    }
  }
})
