import { create } from 'zustand'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { refreshDynamicToolCatalog } from '@renderer/lib/tools/dynamic-tool-catalog'

export type ResourceKind = 'agents' | 'commands'
export type ResourceSource = 'user' | 'bundled'

export interface ManagedResourceItem {
  id: string
  kind: ResourceKind
  name: string
  description: string
  path: string
  source: ResourceSource
  editable: boolean
  effective?: boolean
}

export interface ManagedResourceDetail extends ManagedResourceItem {
  content: string
}

interface ResourcesStore {
  activeKind: ResourceKind
  searchQuery: string
  agents: ManagedResourceItem[]
  commands: ManagedResourceItem[]
  selectedIds: Record<ResourceKind, string | null>
  selectedResource: ManagedResourceDetail | null
  editing: boolean
  draftContent: string | null
  listLoading: boolean
  detailLoading: boolean
  saving: boolean
  error: string | null

  loadAll: () => Promise<void>
  loadItems: (kind: ResourceKind) => Promise<void>
  setActiveKind: (kind: ResourceKind) => void
  setSearchQuery: (query: string) => void
  selectResource: (id: string | null, kind?: ResourceKind) => Promise<void>
  setEditing: (editing: boolean) => void
  setDraftContent: (content: string) => void
  createCommand: (name: string) => Promise<{ success: boolean; error?: string }>
  saveSelected: () => Promise<{ success: boolean; error?: string }>
}

function getListChannel(kind: ResourceKind): string {
  return kind === 'agents' ? IPC.AGENTS_MANAGE_LIST : IPC.COMMANDS_MANAGE_LIST
}

function getReadChannel(kind: ResourceKind): string {
  return kind === 'agents' ? IPC.AGENTS_MANAGE_READ : IPC.COMMANDS_MANAGE_READ
}

function getSaveChannel(kind: ResourceKind): string {
  return kind === 'agents' ? IPC.AGENTS_MANAGE_SAVE : IPC.COMMANDS_MANAGE_SAVE
}

function normalizeList(kind: ResourceKind, result: unknown): ManagedResourceItem[] {
  if (!Array.isArray(result)) return []

  return result
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map(
      (item): ManagedResourceItem => ({
        id: String(item.id ?? item.path ?? ''),
        kind,
        name: String(item.name ?? ''),
        description: String(item.description ?? item.summary ?? ''),
        path: String(item.path ?? ''),
        source: item.source === 'bundled' ? 'bundled' : 'user',
        editable: Boolean(item.editable),
        effective: typeof item.effective === 'boolean' ? item.effective : undefined
      })
    )
    .filter((item) => item.id && item.name && item.path)
}

function getItemsByKind(state: ResourcesStore, kind: ResourceKind): ManagedResourceItem[] {
  return kind === 'agents' ? state.agents : state.commands
}

export const useResourcesStore = create<ResourcesStore>((set, get) => ({
  activeKind: 'agents',
  searchQuery: '',
  agents: [],
  commands: [],
  selectedIds: {
    agents: null,
    commands: null
  },
  selectedResource: null,
  editing: false,
  draftContent: null,
  listLoading: false,
  detailLoading: false,
  saving: false,
  error: null,

  loadAll: async () => {
    set({ listLoading: true, error: null })
    try {
      const [agentsResult, commandsResult] = await Promise.all([
        ipcClient.invoke(IPC.AGENTS_MANAGE_LIST),
        ipcClient.invoke(IPC.COMMANDS_MANAGE_LIST)
      ])

      set({
        agents: normalizeList('agents', agentsResult),
        commands: normalizeList('commands', commandsResult),
        listLoading: false
      })
    } catch (error) {
      set({
        agents: [],
        commands: [],
        listLoading: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  },

  loadItems: async (kind) => {
    set({ listLoading: true, error: null })
    try {
      const result = await ipcClient.invoke(getListChannel(kind))
      const items = normalizeList(kind, result)
      set(
        kind === 'agents'
          ? {
              agents: items,
              listLoading: false
            }
          : {
              commands: items,
              listLoading: false
            }
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set(
        kind === 'agents'
          ? {
              agents: [],
              listLoading: false,
              error: message
            }
          : {
              commands: [],
              listLoading: false,
              error: message
            }
      )
    }
  },

  setActiveKind: (kind) =>
    set({
      activeKind: kind,
      searchQuery: '',
      editing: false,
      draftContent: null,
      error: null
    }),

  setSearchQuery: (query) => set({ searchQuery: query }),

  selectResource: async (id, kind) => {
    const targetKind = kind ?? get().activeKind
    set((state) => ({
      selectedIds: {
        ...state.selectedIds,
        [targetKind]: id
      },
      selectedResource: id ? state.selectedResource : null,
      editing: false,
      draftContent: null,
      detailLoading: Boolean(id),
      error: null
    }))

    if (!id) return

    const item = getItemsByKind(get(), targetKind).find((entry) => entry.id === id)
    if (!item) {
      set({ detailLoading: false, error: 'Resource not found' })
      return
    }

    try {
      const result = (await ipcClient.invoke(getReadChannel(targetKind), {
        path: item.path
      })) as
        | {
            id?: string
            name?: string
            description?: string
            summary?: string
            path?: string
            source?: ResourceSource
            editable?: boolean
            effective?: boolean
            content?: string
            error?: string
          }
        | undefined

      if (result?.error) {
        set({ detailLoading: false, error: result.error, selectedResource: null })
        return
      }

      set({
        detailLoading: false,
        selectedResource: {
          id: String(result?.id ?? item.id),
          kind: targetKind,
          name: String(result?.name ?? item.name),
          description: String(result?.description ?? result?.summary ?? item.description),
          path: String(result?.path ?? item.path),
          source: result?.source === 'bundled' ? 'bundled' : item.source,
          editable: typeof result?.editable === 'boolean' ? result.editable : item.editable,
          effective: typeof result?.effective === 'boolean' ? result.effective : item.effective,
          content: String(result?.content ?? '')
        }
      })
    } catch (error) {
      set({
        detailLoading: false,
        selectedResource: null,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  },

  setEditing: (editing) => {
    const selectedResource = get().selectedResource
    if (editing && !selectedResource?.editable) return

    set({
      editing,
      draftContent: editing ? (selectedResource?.content ?? '') : null
    })
  },

  setDraftContent: (content) => set({ draftContent: content }),

  createCommand: async (name) => {
    const normalizedName = name.trim()
    if (!normalizedName) {
      return { success: false, error: 'Command name is required' }
    }

    set({ saving: true, error: null })
    try {
      const result = (await ipcClient.invoke(IPC.COMMANDS_MANAGE_CREATE, {
        name: normalizedName
      })) as { success?: boolean; path?: string; error?: string }

      if (!result?.success || !result.path) {
        const error = result?.error || 'Create command failed'
        set({ saving: false, error })
        return { success: false, error }
      }

      await get().loadItems('commands')
      await get().selectResource(`user:${result.path}`, 'commands')
      set({ saving: false })
      get().setEditing(true)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ saving: false, error: message })
      return { success: false, error: message }
    }
  },

  saveSelected: async () => {
    const { selectedResource, draftContent } = get()
    if (!selectedResource) {
      return { success: false, error: 'No resource selected' }
    }
    if (!selectedResource.editable) {
      return { success: false, error: 'This resource is read-only' }
    }

    set({ saving: true, error: null })
    try {
      const result = (await ipcClient.invoke(getSaveChannel(selectedResource.kind), {
        path: selectedResource.path,
        content: draftContent ?? selectedResource.content
      })) as { success?: boolean; error?: string }

      if (!result?.success) {
        const error = result?.error || 'Save failed'
        set({ saving: false, error })
        return { success: false, error }
      }

      if (selectedResource.kind === 'agents') {
        await refreshDynamicToolCatalog()
      }

      await get().loadItems(selectedResource.kind)
      await get().selectResource(selectedResource.id, selectedResource.kind)
      set({ saving: false, editing: false, draftContent: null })
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ saving: false, error: message })
      return { success: false, error: message }
    }
  }
}))
