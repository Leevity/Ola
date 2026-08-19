import { create } from 'zustand'

export type LiveCompressionState = 'compressing' | 'completed' | 'failed'

export interface LiveCompressionEntry {
  sessionId: string
  state: LiveCompressionState
  attempt: number
  maxAttempts: number
  draft: string
  preTokens?: number
  keptMessageCount?: number
  updatedAt: number
}

interface LiveCompressionStore {
  bySessionId: Record<string, LiveCompressionEntry>
  start: (sessionId: string, attempt?: number, maxAttempts?: number) => void
  updateDraft: (sessionId: string, draft: string, attempt?: number) => void
  complete: (sessionId: string, details?: Pick<LiveCompressionEntry, 'preTokens' | 'keptMessageCount'>) => void
  fail: (sessionId: string) => void
  clear: (sessionId: string) => void
}

export const useLiveCompressionStore = create<LiveCompressionStore>((set) => ({
  bySessionId: {},
  start: (sessionId, attempt = 1, maxAttempts = 3) =>
    set((state) => ({
      bySessionId: {
        ...state.bySessionId,
        [sessionId]: {
          sessionId,
          state: 'compressing',
          attempt,
          maxAttempts,
          draft: '',
          updatedAt: Date.now()
        }
      }
    })),
  updateDraft: (sessionId, draft, attempt) =>
    set((state) => {
      const previous = state.bySessionId[sessionId]
      return {
        bySessionId: {
          ...state.bySessionId,
          [sessionId]: {
            sessionId,
            state: 'compressing',
            attempt: attempt ?? previous?.attempt ?? 1,
            maxAttempts: previous?.maxAttempts ?? 3,
            draft,
            updatedAt: Date.now()
          }
        }
      }
    }),
  complete: (sessionId, details) =>
    set((state) => {
      const previous = state.bySessionId[sessionId]
      return {
        bySessionId: {
          ...state.bySessionId,
          [sessionId]: {
            sessionId,
            state: 'completed',
            attempt: previous?.attempt ?? 1,
            maxAttempts: previous?.maxAttempts ?? 3,
            draft: '',
            ...details,
            updatedAt: Date.now()
          }
        }
      }
    }),
  fail: (sessionId) =>
    set((state) => ({
      bySessionId: {
        ...state.bySessionId,
        ...(state.bySessionId[sessionId]?.state === 'compressing'
          ? {
              [sessionId]: {
                ...state.bySessionId[sessionId],
                state: 'failed' as const,
                updatedAt: Date.now()
              }
            }
          : {})
      }
    })),
  clear: (sessionId) =>
    set((state) => {
      const next = { ...state.bySessionId }
      delete next[sessionId]
      return { bySessionId: next }
    })
}))

export const liveCompressionStore = useLiveCompressionStore
