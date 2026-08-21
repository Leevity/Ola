import { create } from 'zustand'

export type RuntimeProjectionStatus = 'idle' | 'running' | 'completed' | 'failed'

export interface RuntimeSessionProjection {
  sessionId: string
  runId: string | null
  assistantMessageId: string | null
  status: RuntimeProjectionStatus
  thinkingMessageId: string | null
  toolUseCount: number
  lastEventAt: number
}

export type RuntimeProjectionPatch = Partial<
  Pick<RuntimeSessionProjection, 'assistantMessageId' | 'thinkingMessageId'>
> & { toolUse?: boolean }

interface RuntimeProjectionStore {
  projections: Record<string, RuntimeSessionProjection>
  begin: (sessionId: string, runId: string | null, assistantMessageId: string) => void
  touch: (sessionId: string, patch?: RuntimeProjectionPatch) => void
  finish: (
    sessionId: string,
    status: Extract<RuntimeProjectionStatus, 'completed' | 'failed'>
  ) => void
  clear: (sessionId: string) => void
}

function createProjection(sessionId: string): RuntimeSessionProjection {
  return {
    sessionId,
    runId: null,
    assistantMessageId: null,
    status: 'idle',
    thinkingMessageId: null,
    toolUseCount: 0,
    lastEventAt: 0
  }
}

export const useRuntimeProjectionStore = create<RuntimeProjectionStore>((set) => ({
  projections: {},
  begin: (sessionId, runId, assistantMessageId) =>
    set((state) => ({
      projections: {
        ...state.projections,
        [sessionId]: {
          ...createProjection(sessionId),
          runId,
          assistantMessageId,
          status: 'running',
          lastEventAt: Date.now()
        }
      }
    })),
  touch: (sessionId, patch) =>
    set((state) => {
      const current = state.projections[sessionId] ?? createProjection(sessionId)
      const { toolUse, ...projectionPatch } = patch ?? {}
      return {
        projections: {
          ...state.projections,
          [sessionId]: {
            ...current,
            ...projectionPatch,
            toolUseCount: current.toolUseCount + (toolUse ? 1 : 0),
            status: current.status === 'idle' ? 'running' : current.status,
            lastEventAt: Date.now()
          }
        }
      }
    }),
  finish: (sessionId, status) =>
    set((state) => {
      const current = state.projections[sessionId] ?? createProjection(sessionId)
      return {
        projections: {
          ...state.projections,
          [sessionId]: { ...current, status, thinkingMessageId: null, lastEventAt: Date.now() }
        }
      }
    }),
  clear: (sessionId) =>
    set((state) => {
      if (!state.projections[sessionId]) return state
      const projections = { ...state.projections }
      delete projections[sessionId]
      return { projections }
    })
}))
