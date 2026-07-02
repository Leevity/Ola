import { create } from 'zustand'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { useSettingsStore } from '@renderer/stores/settings-store'

export interface SoulMarketInfo {
  id: string
  slug: string
  name: string
  description: string
  category?: string
  downloads: number
  updatedAt?: string
  filePath?: string
  url: string
  downloadUrl: string
}

export interface SoulCategoryInfo {
  value: string
  label: string
}

export type SoulInstallTarget = 'global' | 'project'
export type SoulsSortBy = 'recent' | 'name'

export interface SoulTargetPaths {
  global: { available: boolean; path: string }
  project: { available: boolean; path: string | null }
}

interface SoulsStore {
  souls: SoulMarketInfo[]
  total: number
  loading: boolean
  error: string | null
  query: string
  category: string
  offset: number
  sortBy: SoulsSortBy
  categories: SoulCategoryInfo[]
  categoriesLoading: boolean
  installDialogOpen: boolean
  selectedSoul: SoulMarketInfo | null
  downloadedContent: string
  target: SoulInstallTarget
  targetPaths: SoulTargetPaths | null
  downloading: boolean
  downloadError: string | null
  installing: boolean
  loadSouls: (reset?: boolean) => Promise<void>
  loadMoreSouls: () => Promise<void>
  setQuery: (query: string) => void
  setCategory: (category: string) => void
  setSortBy: (sortBy: SoulsSortBy) => void
  loadCategories: () => Promise<void>
  downloadSoul: (soul: SoulMarketInfo, projectRootPath?: string | null) => Promise<void>
  setTarget: (target: SoulInstallTarget) => void
  installSoul: (
    projectRootPath?: string | null
  ) => Promise<{ success: boolean; path?: string; error?: string }>
  closeInstallDialog: () => void
}

function getApiKey(): string {
  return useSettingsStore.getState().skillsMarketApiKey
}

export const useSoulsStore = create<SoulsStore>((set, get) => ({
  souls: [],
  total: 0,
  loading: false,
  error: null,
  query: '',
  category: '',
  offset: 0,
  sortBy: 'recent',
  categories: [],
  categoriesLoading: false,
  installDialogOpen: false,
  selectedSoul: null,
  downloadedContent: '',
  target: 'global',
  targetPaths: null,
  downloading: false,
  downloadError: null,
  installing: false,

  loadSouls: async (reset = true) => {
    const state = get()
    const offset = reset ? 0 : state.offset
    set({ loading: true })
    try {
      const result = (await ipcClient.invoke(IPC.SOULS_MARKET_LIST, {
        query: state.query,
        category: state.category || undefined,
        offset,
        limit: 50,
        sortBy: state.sortBy,
        apiKey: getApiKey()
      })) as { total: number; souls: SoulMarketInfo[]; error?: string }

      set({
        souls: reset || offset === 0 ? result.souls : [...get().souls, ...result.souls],
        total: result.total,
        offset: offset + result.souls.length,
        error: result.error ?? null
      })
    } catch (err) {
      if (reset || offset === 0) {
        set({
          souls: [],
          total: 0,
          offset: 0,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    } finally {
      set({ loading: false })
    }
  },

  loadMoreSouls: async () => {
    const state = get()
    if (state.loading || state.souls.length >= state.total) return
    await state.loadSouls(false)
  },

  setQuery: (query) => {
    set({ query, offset: 0 })
    void get().loadSouls(true)
  },

  setCategory: (category) => {
    set({ category, offset: 0 })
    void get().loadSouls(true)
  },

  setSortBy: (sortBy) => {
    set({ sortBy, offset: 0 })
    void get().loadSouls(true)
  },

  loadCategories: async () => {
    set({ categoriesLoading: true })
    try {
      const result = (await ipcClient.invoke(IPC.SOULS_CATEGORIES, {
        apiKey: getApiKey()
      })) as { categories: SoulCategoryInfo[] }
      set({ categories: Array.isArray(result.categories) ? result.categories : [] })
    } catch {
      set({ categories: [] })
    } finally {
      set({ categoriesLoading: false })
    }
  },

  downloadSoul: async (soul, projectRootPath) => {
    set({
      installDialogOpen: true,
      selectedSoul: soul,
      downloadedContent: '',
      target: 'global',
      targetPaths: null,
      downloading: true,
      downloadError: null,
      installing: false
    })

    try {
      const [downloadResult, targetPaths] = await Promise.all([
        ipcClient.invoke(IPC.SOULS_DOWNLOAD_REMOTE, {
          slug: soul.slug,
          downloadUrl: soul.downloadUrl,
          apiKey: getApiKey()
        }) as Promise<{ content?: string; error?: string }>,
        ipcClient.invoke(IPC.SOULS_GET_TARGET_PATHS, {
          projectRootPath: projectRootPath ?? undefined
        }) as Promise<SoulTargetPaths>
      ])

      if (downloadResult.error || !downloadResult.content) {
        set({
          downloadedContent: '',
          targetPaths,
          downloading: false,
          downloadError: downloadResult.error ?? 'SOUL content is empty'
        })
        return
      }

      set({
        downloadedContent: downloadResult.content,
        targetPaths,
        downloading: false,
        downloadError: null
      })
    } catch (err) {
      set({
        downloading: false,
        downloadError: err instanceof Error ? err.message : String(err)
      })
    }
  },

  setTarget: (target) => set({ target }),

  installSoul: async (projectRootPath) => {
    const state = get()
    if (!state.downloadedContent) return { success: false, error: 'No SOUL content' }
    set({ installing: true })
    try {
      const result = (await ipcClient.invoke(IPC.SOULS_INSTALL, {
        content: state.downloadedContent,
        target: state.target,
        projectRootPath: projectRootPath ?? undefined
      })) as { success: boolean; path?: string; error?: string }

      if (result.success) {
        set({
          installDialogOpen: false,
          selectedSoul: null,
          downloadedContent: '',
          targetPaths: null,
          downloadError: null,
          installing: false
        })
      } else {
        set({ installing: false })
      }
      return result
    } catch (err) {
      set({ installing: false })
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  closeInstallDialog: () =>
    set({
      installDialogOpen: false,
      selectedSoul: null,
      downloadedContent: '',
      target: 'global',
      targetPaths: null,
      downloading: false,
      downloadError: null,
      installing: false
    })
}))
