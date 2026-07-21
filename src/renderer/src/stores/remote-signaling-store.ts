import { create } from 'zustand'

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
const DEFAULT_SIGNAL_URL = 'ws://127.0.0.1:7301/ws/signaling'

let socket: WebSocket | null = null
const listeners = new Set<RemoteSignalListener>()

export function subscribeRemoteSignalMessages(listener: RemoteSignalListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emitSignalMessage(message: RemoteSignalMessage): void {
  for (const listener of listeners) listener(message)
}

function loadSignalUrl(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) || DEFAULT_SIGNAL_URL
  } catch {
    return DEFAULT_SIGNAL_URL
  }
}

function persistSignalUrl(signalUrl: string): void {
  window.localStorage.setItem(STORAGE_KEY, signalUrl)
}

export const useRemoteSignalingStore = create<RemoteSignalingStore>((set, get) => ({
  signalUrl: loadSignalUrl(),
  status: 'idle',
  error: null,
  lastMessage: null,
  setSignalUrl: (signalUrl) => {
    const next = signalUrl.trim() || DEFAULT_SIGNAL_URL
    set({ signalUrl: next })
    persistSignalUrl(next)
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
      set({ status: 'connecting', error: null })
      const ws = new WebSocket(get().signalUrl, ['ola-remote-v1', `ola-token.${deviceToken}`])
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
