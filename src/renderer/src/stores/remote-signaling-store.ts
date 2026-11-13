import { create } from 'zustand'
import { signalingUrlForApi } from '../../../shared/remote-control'

export type RemoteSignalStatus = 'idle' | 'connecting' | 'connected' | 'error'

export type RemoteSignalMessage = {
  type: string
  from?: string
  to?: string
  sessionId?: string
  payload?: unknown
  authorization?: string
  peerName?: string
  sentAt?: string
}

export type RemoteSignalListener = (message: RemoteSignalMessage) => void

type RemoteSignalingStore = {
  signalUrl: string
  status: RemoteSignalStatus
  error: string | null
  lastMessage: RemoteSignalMessage | null
  setSignalUrl: (signalUrl: string) => void
  connect: (deviceToken: string) => Promise<void>
  disconnect: () => void
  send: (message: Omit<RemoteSignalMessage, 'from' | 'sentAt'>) => void
}

const STORAGE_KEY = 'ola.remote.signaling'
const ACCOUNT_STORAGE_KEY = 'ola.remote.account'
/**
 * Only used when the account store has no base URL at all (fresh profile,
 * storage wiped): fall back to the production host instead of a developer
 * machine's private address, which no real user could ever reach.
 */
const FALLBACK_API_BASE_URL = 'https://lbxai.cn'

let socket: WebSocket | null = null
const listeners = new Set<RemoteSignalListener>()

export function subscribeRemoteSignalMessages(listener: RemoteSignalListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emitSignalMessage(message: RemoteSignalMessage): void {
  for (const listener of listeners) listener(message)
}

/**
 * An explicitly stored address wins; otherwise the endpoint follows wherever
 * the account points. Resolving on every connect (not once at module load) is
 * what lets switching servers in settings take effect without a restart.
 */
function resolveSignalUrl(): string {
  try {
    const explicit = window.localStorage.getItem(STORAGE_KEY)
    if (explicit) return explicit
    const account = window.localStorage.getItem(ACCOUNT_STORAGE_KEY)
    const apiBaseUrl = account
      ? ((JSON.parse(account) as { apiBaseUrl?: string } | null)?.apiBaseUrl ?? '')
      : ''
    return (
      signalingUrlForApi(apiBaseUrl) ||
      signalingUrlForApi(FALLBACK_API_BASE_URL) ||
      'wss://lbxai.cn/ws/signaling'
    )
  } catch {
    return 'wss://lbxai.cn/ws/signaling'
  }
}

export const useRemoteSignalingStore = create<RemoteSignalingStore>((set) => ({
  signalUrl: resolveSignalUrl(),
  status: 'idle',
  error: null,
  lastMessage: null,
  setSignalUrl: (signalUrl) => {
    const next = signalUrl.trim()
    // Clearing the field means "follow the account server again", not "no
    // endpoint": an empty override would silently break every later connect.
    if (next) window.localStorage.setItem(STORAGE_KEY, next)
    else window.localStorage.removeItem(STORAGE_KEY)
    const resolved = resolveSignalUrl()
    set({ signalUrl: resolved })
  },
  connect: (deviceToken) =>
    new Promise<void>((resolve, reject) => {
      if (!deviceToken) {
        const error = new Error('A device signaling token is required before connecting')
        set({ status: 'error', error: error.message })
        reject(error)
        return
      }
      socket?.close()
      const signalUrl = resolveSignalUrl()
      set({ status: 'connecting', error: null, signalUrl })
      const ws = new WebSocket(signalUrl, ['ola-remote-v1', `ola-token.${deviceToken}`])
      socket = ws
      ws.onopen = () => {
        set({ status: 'connected', error: null })
        resolve()
      }
      ws.onerror = () => {
        const error = new Error('Signaling connection failed')
        set({ status: 'error', error: error.message })
        reject(error)
      }
      ws.onmessage = (event) => {
        const message = (() => {
          try {
            return JSON.parse(String(event.data)) as RemoteSignalMessage
          } catch {
            return {
              type: 'raw',
              payload: String(event.data)
            } satisfies RemoteSignalMessage
          }
        })()
        set({ lastMessage: message })
        emitSignalMessage(message)
      }
      ws.onclose = () => {
        if (socket === ws) {
          socket = null
          set((state) => ({ status: state.status === 'error' ? 'error' : 'idle' }))
        }
      }
    }),
  disconnect: () => {
    socket?.close()
    socket = null
    set({ status: 'idle', error: null })
  },
  send: (message) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Signaling is not connected')
    }
    socket.send(JSON.stringify(message))
  }
}))
