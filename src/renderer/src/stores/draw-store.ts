import { create } from 'zustand'
import type { DrawRun } from '@renderer/lib/draw-history'

type DrawRunsUpdater = DrawRun[] | ((current: DrawRun[]) => DrawRun[])

interface DrawStore {
  runs: DrawRun[]
  commitRuns: (updater: DrawRunsUpdater) => DrawRun[]
  updateRun: (runId: string, updater: (run: DrawRun) => DrawRun) => DrawRun | null
}

const activeDrawRunControllers = new Map<string, AbortController>()

export const useDrawStore = create<DrawStore>()((set, get) => ({
  runs: [],
  commitRuns: (updater) => {
    const nextRuns = typeof updater === 'function' ? updater(get().runs) : updater
    set({ runs: nextRuns })
    return nextRuns
  },
  updateRun: (runId, updater) => {
    let nextRun: DrawRun | null = null

    set((state) => ({
      runs: state.runs.map((run) => {
        if (run.id !== runId) return run
        const updatedRun = updater(run)
        nextRun = updatedRun
        return updatedRun
      })
    }))

    return nextRun
  }
}))

export function registerDrawRunController(runId: string, controller: AbortController): void {
  activeDrawRunControllers.set(runId, controller)
}

export function unregisterDrawRunController(runId: string, controller?: AbortController): void {
  if (controller && activeDrawRunControllers.get(runId) !== controller) return
  activeDrawRunControllers.delete(runId)
}

export function getActiveDrawRunIds(): Set<string> {
  return new Set(activeDrawRunControllers.keys())
}

export function abortActiveDrawRuns(): void {
  for (const controller of activeDrawRunControllers.values()) {
    controller.abort()
  }
}
