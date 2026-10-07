import {
  legacyModelSource,
  modelSourceSelection,
  parseModelSource,
  type ModelSource
} from '../../../shared/runtime/model-source'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { ipcStorage } from '@renderer/lib/ipc/ipc-storage'
import {
  LOCAL_PERSONAL_WORKSPACE,
  LOCAL_PERSONAL_WORKSPACE_ID,
  type OlaModelResource,
  type WorkspaceContext
} from '@renderer/lib/workspace-context'

export type WorkspaceModelSelection = { providerId: string; modelId: string }

type WorkspaceStore = {
  modelSelections: Record<string, WorkspaceModelSelection>
  modelSources: Record<string, ModelSource>
  getModelSelection: (selectionKey: string) => WorkspaceModelSelection | undefined
  setModelSelection: (workspaceId: string, selection: WorkspaceModelSelection) => void
  activeWorkspaceId: string
  olaWorkspaces: WorkspaceContext[]
  resourcesByWorkspace: Record<string, OlaModelResource[]>
  lastSyncedAt: number | null
  setActiveWorkspace: (workspaceId: string) => void
  replaceOlaWorkspaces: (workspaces: WorkspaceContext[]) => void
  setResources: (workspaceId: string, resources: OlaModelResource[]) => void
  clearOlaState: () => void
  getWorkspaces: () => WorkspaceContext[]
  getActiveWorkspace: () => WorkspaceContext
}

function normalizeWorkspaces(workspaces: WorkspaceContext[]): WorkspaceContext[] {
  const unique = new Map<string, WorkspaceContext>()
  for (const workspace of workspaces) {
    if (!workspace.id || workspace.id === LOCAL_PERSONAL_WORKSPACE_ID) continue
    if (workspace.kind !== 'ola-personal' && workspace.kind !== 'ola-team') continue
    unique.set(workspace.id, workspace)
  }
  return [...unique.values()]
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set, get) => ({
      modelSelections: {},
      modelSources: {},
      getModelSelection: (selectionKey) => {
        const source = get().modelSources[selectionKey]
        if (!source) return get().modelSelections[selectionKey]
        try {
          return modelSourceSelection(parseModelSource(source))
        } catch {
          // A persisted explicit binding is authoritative. Do not resurrect a
          // stale legacy provider selection if its typed form is malformed or
          // has been revoked; the normal "select a model" UI can recover it.
          return undefined
        }
      },
      setModelSelection: (selectionKey, selection) => {
        let workspaceId = selectionKey
        if (selectionKey.startsWith('[')) {
          try {
            const parts: unknown = JSON.parse(selectionKey)
            if (Array.isArray(parts) && typeof parts[0] === 'string') workspaceId = parts[0]
          } catch {
            return
          }
        }
        const workspace = get()
          .getWorkspaces()
          .find((item) => item.id === workspaceId)
        if (!workspace) return
        const source = legacyModelSource(selection.providerId, selection.modelId, workspace.kind)
        if (source.kind !== 'local' && source.workspaceId !== workspaceId) return
        set((state) => ({
          modelSelections: {
            ...state.modelSelections,
            [selectionKey]: { providerId: selection.providerId, modelId: selection.modelId }
          },
          modelSources: { ...state.modelSources, [selectionKey]: source }
        }))
      },
      activeWorkspaceId: LOCAL_PERSONAL_WORKSPACE_ID,
      olaWorkspaces: [],
      resourcesByWorkspace: {},
      lastSyncedAt: null,
      setActiveWorkspace: (workspaceId) => {
        const exists =
          workspaceId === LOCAL_PERSONAL_WORKSPACE_ID ||
          get().olaWorkspaces.some((workspace) => workspace.id === workspaceId)
        if (exists) set({ activeWorkspaceId: workspaceId })
      },
      replaceOlaWorkspaces: (workspaces) => {
        const olaWorkspaces = normalizeWorkspaces(workspaces)
        const activeWorkspaceId = get().activeWorkspaceId
        const activeStillExists =
          activeWorkspaceId === LOCAL_PERSONAL_WORKSPACE_ID ||
          olaWorkspaces.some((workspace) => workspace.id === activeWorkspaceId)
        const visibleIds = new Set(olaWorkspaces.map((workspace) => workspace.id))
        const resourcesByWorkspace = Object.fromEntries(
          Object.entries(get().resourcesByWorkspace).filter(([workspaceId]) =>
            visibleIds.has(workspaceId)
          )
        )
        set({
          olaWorkspaces,
          resourcesByWorkspace,
          activeWorkspaceId: activeStillExists ? activeWorkspaceId : LOCAL_PERSONAL_WORKSPACE_ID,
          lastSyncedAt: Date.now()
        })
      },
      setResources: (workspaceId, resources) => {
        if (!get().olaWorkspaces.some((workspace) => workspace.id === workspaceId)) return
        set((state) => ({
          resourcesByWorkspace: { ...state.resourcesByWorkspace, [workspaceId]: resources },
          lastSyncedAt: Date.now()
        }))
      },
      clearOlaState: () =>
        set({
          activeWorkspaceId: LOCAL_PERSONAL_WORKSPACE_ID,
          olaWorkspaces: [],
          resourcesByWorkspace: {},
          lastSyncedAt: null
        }),
      getWorkspaces: () => [LOCAL_PERSONAL_WORKSPACE, ...get().olaWorkspaces],
      getActiveWorkspace: () =>
        get()
          .getWorkspaces()
          .find((workspace) => workspace.id === get().activeWorkspaceId) ?? LOCAL_PERSONAL_WORKSPACE
    }),
    {
      name: 'ola.workspace-context.v1',
      storage: createJSONStorage(() => ({
        getItem: async (name) => {
          if (typeof localStorage === 'undefined') return null
          const saved = await ipcStorage.getItem(name)
          if (saved !== null) return saved
          const legacy = localStorage.getItem(name)
          if (legacy !== null) await ipcStorage.setItem(name, legacy)
          return legacy
        },
        setItem: async (name, value) => {
          if (typeof localStorage === 'undefined') return
          localStorage.setItem(name, value)
          await ipcStorage.setItem(name, value)
        },
        removeItem: async (name) => {
          if (typeof localStorage === 'undefined') return
          localStorage.removeItem(name)
          await ipcStorage.removeItem(name)
        }
      })),
      partialize: (state) => ({
        modelSelections: state.modelSelections,
        modelSources: state.modelSources,
        activeWorkspaceId: state.activeWorkspaceId,
        olaWorkspaces: state.olaWorkspaces,
        resourcesByWorkspace: state.resourcesByWorkspace,
        lastSyncedAt: state.lastSyncedAt
      })
    }
  )
)
