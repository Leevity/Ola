import { create } from 'zustand'
import { toast } from 'sonner'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'

export type LocalTerminalStatus = 'running' | 'exited' | 'error'

export interface LocalTerminalTab {
  id: string
  projectId: string | null
  title: string
  cwd: string
  shell: string
  createdAt: number
  status: LocalTerminalStatus
  exitCode?: number
}

export interface LocalTerminalSession {
  id: string
  title: string
  cwd: string
  shell: string
  cols: number
  rows: number
  createdAt: number
  status: LocalTerminalStatus
  command?: string
  exitCode?: number
  exitSignal?: number
}

interface TerminalListEntry {
  id?: string
  title?: string
  cwd?: string
  shell?: string
  cols?: number
  rows?: number
  createdAt?: number
  command?: string
  exitCode?: number
  exitSignal?: number
}

interface TerminalStore {
  tabs: LocalTerminalTab[]
  sessions: Record<string, LocalTerminalSession>
  activeTabId: string | null
  initialized: boolean
  init: () => void
  refreshSessions: () => Promise<void>
  createTab: (
    cwd?: string,
    title?: string,
    initialCommand?: string,
    projectId?: string | null
  ) => Promise<string | null>
  closeTab: (id: string) => Promise<void>
  closeSession: (id: string) => Promise<void>
  setActiveTab: (id: string | null) => void
  findTabByCwd: (cwd?: string | null, projectId?: string | null) => LocalTerminalTab | null
  markExited: (id: string, exitCode?: number, exitSignal?: number) => void
}

let subscribed = false
let pendingRefreshTimer: ReturnType<typeof setTimeout> | null = null

function getTerminalStatus(exitCode?: number, exitSignal?: number): LocalTerminalStatus {
  if (exitCode === undefined && exitSignal === undefined) return 'running'
  return exitCode === 0 ? 'exited' : 'error'
}

function normalizeTerminalSession(entry: TerminalListEntry): LocalTerminalSession | null {
  if (!entry.id?.trim()) return null
  return {
    id: entry.id,
    title: entry.title?.trim() || 'Terminal',
    cwd: entry.cwd || '',
    shell: entry.shell || '',
    cols: Math.max(20, Math.floor(entry.cols ?? 80)),
    rows: Math.max(5, Math.floor(entry.rows ?? 24)),
    createdAt: entry.createdAt || Date.now(),
    status: getTerminalStatus(entry.exitCode, entry.exitSignal),
    command: entry.command?.trim() || undefined,
    exitCode: entry.exitCode,
    exitSignal: entry.exitSignal
  }
}

function scheduleTerminalSessionRefresh(refresh: () => Promise<void>): void {
  if (pendingRefreshTimer) return
  pendingRefreshTimer = setTimeout(() => {
    pendingRefreshTimer = null
    void refresh()
  }, 80)
}

function buildNextTitle(
  tabs: LocalTerminalTab[],
  preferredTitle?: string,
  projectId?: string | null
): string {
  const baseTitle = preferredTitle?.trim() || 'Terminal'
  const normalizedProjectId = projectId ?? null
  const scopedTabs = tabs.filter((tab) => (tab.projectId ?? null) === normalizedProjectId)
  if (!scopedTabs.some((tab) => tab.title === baseTitle)) return baseTitle

  let nextIndex = 2
  while (scopedTabs.some((tab) => tab.title === `${baseTitle} ${nextIndex}`)) {
    nextIndex += 1
  }

  return `${baseTitle} ${nextIndex}`
}

export const useTerminalStore = create<TerminalStore>()((set, get) => ({
  tabs: [],
  sessions: {},
  activeTabId: null,
  initialized: false,
  init: () => {
    if (subscribed) {
      if (!get().initialized) set({ initialized: true })
      return
    }

    subscribed = true

    ipcClient.on(IPC.TERMINAL_CREATED, (payload) => {
      const session = normalizeTerminalSession(payload as TerminalListEntry)
      if (!session) return
      set((state) => ({
        sessions: {
          ...state.sessions,
          [session.id]: session
        }
      }))
    })

    ipcClient.on(IPC.TERMINAL_EXIT, (payload) => {
      const data = payload as { id?: string; exitCode?: number; signal?: number }
      if (!data?.id) return
      get().markExited(data.id, data.exitCode, data.signal)
    })

    ipcClient.on(IPC.TERMINAL_OUTPUT, (payload) => {
      const data = payload as { id?: string }
      if (!data?.id || get().sessions[data.id]) return
      scheduleTerminalSessionRefresh(get().refreshSessions)
    })

    set({ initialized: true })
    void get().refreshSessions()
  },
  refreshSessions: async () => {
    try {
      const result = await ipcClient.invoke(IPC.TERMINAL_LIST)
      const entries = Array.isArray(result) ? (result as TerminalListEntry[]) : []
      const sessions: Record<string, LocalTerminalSession> = {}
      for (const entry of entries) {
        const session = normalizeTerminalSession(entry)
        if (session) sessions[session.id] = session
      }
      set({ sessions })
    } catch {
      return
    }
  },
  createTab: async (cwd, preferredTitle, initialCommand, projectId) => {
    const title = buildNextTitle(get().tabs, preferredTitle, projectId)
    const result = (await ipcClient.invoke(IPC.TERMINAL_CREATE, {
      cwd,
      title
    })) as
      | {
          id?: string
          cwd?: string
          shell?: string
          createdAt?: number
          title?: string
          command?: string
          error?: string
        }
      | undefined

    if (!result?.id || result.error) {
      toast.error('Failed to create terminal', {
        description: result?.error || 'Unknown error'
      })
      return null
    }

    const tab: LocalTerminalTab = {
      id: result.id,
      projectId: projectId ?? null,
      title: result.title || title,
      cwd: result.cwd || cwd || '',
      shell: result.shell || '',
      createdAt: result.createdAt || Date.now(),
      status: 'running'
    }
    const session = normalizeTerminalSession({
      id: result.id,
      title: result.title || title,
      cwd: result.cwd || cwd || '',
      shell: result.shell || '',
      createdAt: result.createdAt || Date.now(),
      command: result.command
    })

    set((state) => ({
      tabs: [...state.tabs, tab],
      sessions: session
        ? {
            ...state.sessions,
            [session.id]: session
          }
        : state.sessions,
      activeTabId: tab.id
    }))

    if (initialCommand && initialCommand.trim().length > 0) {
      const command = initialCommand.trim()
      setTimeout(() => {
        void ipcClient.invoke(IPC.TERMINAL_INPUT, {
          id: tab.id,
          data: `${command}\r`
        })
      }, 400)
    }

    return tab.id
  },
  closeTab: async (id) => {
    await get().closeSession(id)
    set((state) => {
      const idx = state.tabs.findIndex((tab) => tab.id === id)
      const tabs = state.tabs.filter((tab) => tab.id !== id)
      return {
        tabs,
        activeTabId:
          state.activeTabId === id
            ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null)
            : state.activeTabId
      }
    })
  },
  closeSession: async (id) => {
    let result: { success?: boolean; error?: string } | undefined
    try {
      result = (await ipcClient.invoke(IPC.TERMINAL_KILL, { id })) as
        | { success?: boolean; error?: string }
        | undefined
    } catch (error) {
      toast.error('Failed to close terminal', {
        description: error instanceof Error ? error.message : String(error)
      })
      return
    }

    if (result?.error && !result.error.includes('Terminal not found')) {
      toast.error('Failed to close terminal', {
        description: result.error
      })
      return
    }

    set((state) => {
      const session = state.sessions[id]
      return {
        tabs: state.tabs.map((tab) =>
          tab.id === id
            ? {
                ...tab,
                status: 'exited' as const
              }
            : tab
        ),
        sessions: session
          ? {
              ...state.sessions,
              [id]: {
                ...session,
                status: 'exited' as const
              }
            }
          : state.sessions
      }
    })
  },
  setActiveTab: (id) => set({ activeTabId: id }),
  findTabByCwd: (cwd, projectId) => {
    if (!cwd) return null
    const normalizedProjectId = projectId ?? null
    return (
      get().tabs.find(
        (tab) => tab.cwd === cwd && (tab.projectId ?? null) === normalizedProjectId
      ) ?? null
    )
  },
  markExited: (id, exitCode, exitSignal) =>
    set((state) => {
      const nextStatus = getTerminalStatus(exitCode, exitSignal)
      const session = state.sessions[id]
      return {
        tabs: state.tabs.map((tab) =>
          tab.id === id
            ? {
                ...tab,
                status: nextStatus,
                exitCode
              }
            : tab
        ),
        sessions: session
          ? {
              ...state.sessions,
              [id]: {
                ...session,
                status: nextStatus,
                exitCode,
                exitSignal
              }
            }
          : state.sessions
      }
    })
}))
