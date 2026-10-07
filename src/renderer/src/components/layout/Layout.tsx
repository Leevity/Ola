import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTheme } from 'next-themes'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { TitleBar } from './TitleBar'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { RightPanel } from './RightPanel'
import { SubAgentExecutionDetail } from './SubAgentExecutionDetail'
import { WorkspaceHome } from '@renderer/components/chat/WorkspaceHome'
import { ProjectArchivePage } from '@renderer/components/chat/ProjectArchivePage'
import { GitPage } from '@renderer/components/chat/GitPage'
import { KeyboardShortcutsDialog } from '@renderer/components/settings/KeyboardShortcutsDialog'
import { PermissionDialog } from '@renderer/components/cowork/PermissionDialog'
import { ConversationGuideDialog } from '@renderer/components/chat/ConversationGuideDialog'
import { SettingsPage } from '@renderer/components/settings/SettingsPage'
import { UsagePage } from '@renderer/components/settings/UsagePage'
import { PetStudioPage } from '@renderer/components/settings/PetStudioPage'
import { AccountAuthPage } from '@renderer/components/account/AccountAuthPage'
import { CommandPalette } from './CommandPalette'
import {
  initializeWorkbenchRegistry,
  registerWorkbenchAction,
  runWorkbenchAction
} from '@renderer/lib/workbench'
import { workspaceLayoutStorageKey } from '@renderer/lib/workbench/workspace-layout'
import { SessionConversationPane } from './SessionConversationPane'
import { SessionTabStrip } from './SessionTabStrip'
import { WorkspaceTabStrip } from './WorkspaceTabStrip'
import { ExtensionWorkbenchViewDialog } from './ExtensionWorkbenchViewDialog'
import { WorkingFolderSheet } from './WorkingFolderSheet'
import { ErrorBoundary } from '@renderer/components/error-boundary'
import { useUIStore, type AppMode } from '@renderer/stores/ui-store'
import { useChatStore, type SessionMode } from '@renderer/stores/chat-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'
import {
  abortSession,
  clearPendingSessionMessages,
  useChatActions
} from '@renderer/hooks/use-chat-actions'
import { toast } from 'sonner'
import {
  exportSessionMarkdownFromDb,
  exportSessionSnapshotFromDb
} from '@renderer/lib/utils/export-chat'
import { AnimatePresence } from 'motion/react'
import { PageTransition, PanelTransition } from '@renderer/components/animate-ui'
import { openSessionOrFocusDetached } from '@renderer/lib/session-window'
import { useShallow } from 'zustand/react/shallow'
import { selectSessionPendingApproval } from '@renderer/lib/agent/session-scoped-agent-state'

const SkillsPage = lazy(async () => {
  const mod = await import('@renderer/components/skills/SkillsPage')
  return { default: mod.SkillsPage }
})

const SoulsPage = lazy(async () => {
  const mod = await import('@renderer/components/souls/SoulsPage')
  return { default: mod.SoulsPage }
})

const SyncPage = lazy(async () => {
  const mod = await import('@renderer/components/sync/SyncPage')
  return { default: mod.SyncPage }
})

const ResourcesPage = lazy(async () => {
  const mod = await import('@renderer/components/resources/ResourcesPage')
  return { default: mod.ResourcesPage }
})

const TranslatePage = lazy(async () => {
  const mod = await import('@renderer/components/translate/TranslatePage')
  return { default: mod.TranslatePage }
})

const DrawPage = lazy(async () => {
  const mod = await import('@renderer/components/draw/DrawPage')
  return { default: mod.DrawPage }
})

const TasksPage = lazy(async () => {
  const mod = await import('../tasks/TasksPage')
  return { default: mod.TasksPage }
})

const MIN_MAIN_WORKSPACE_WIDTH_WITH_SIDEBAR = 720
const MIN_VIEWPORT_WIDTH_WITH_SIDEBAR = 680
const MULTI_RIGHT_PANEL_COLLAPSE_VIEWPORT = 1600

function LazyPageFallback(): React.JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
    </div>
  )
}

initializeWorkbenchRegistry()

interface LayoutUpdateInfo {
  newVersion: string
  downloading: boolean
  downloadProgress: number | null
  downloaded?: boolean
}

interface LayoutProps {
  updateInfo: LayoutUpdateInfo | null
  onOpenUpdateDialog: () => void
}

export function Layout({ updateInfo, onOpenUpdateDialog }: LayoutProps): React.JSX.Element {
  const { t } = useTranslation('layout')
  const mode = useUIStore((s) => s.mode)
  const activeSurface = useUIStore((s) => s.activeSurface)
  const tasksPageOpen = activeSurface === 'tasks'
  const setMode = useUIStore((s) => s.setMode)
  const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen)
  const leftSidebarWidth = useUIStore((s) => s.leftSidebarWidth)
  const setLeftSidebarOpen = useUIStore((s) => s.setLeftSidebarOpen)
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen)
  const rightPanelWidth = useUIStore((s) => s.rightPanelWidth)
  const workingFolderSheetOpen = useUIStore((s) => s.workingFolderSheetOpen)
  const workingFolderPanelWidth = useUIStore((s) => s.workingFolderPanelWidth)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const splitSessionKey = workspaceLayoutStorageKey(activeWorkspaceId)
  const splitSessionId = useUIStore((s) => s.splitSessionByWorkspace[splitSessionKey] ?? null)
  const openWorkspaceSplit = useUIStore((s) => s.openWorkspaceSplit)
  const closeWorkspaceSplit = useUIStore((s) => s.closeWorkspaceSplit)
  const subAgentExecutionDetailOpen = useUIStore((s) => s.subAgentExecutionDetailOpen)
  const subAgentExecutionDetailToolUseId = useUIStore((s) => s.subAgentExecutionDetailToolUseId)
  const subAgentExecutionDetailInlineText = useUIStore((s) => s.subAgentExecutionDetailInlineText)
  const closeSubAgentExecutionDetail = useUIStore((s) => s.closeSubAgentExecutionDetail)
  const chatView = useUIStore((s) => s.chatView)
  const activeSessionView = useChatStore(
    useShallow((s) => {
      const activeSession = s.sessions.find((session) => session.id === s.activeSessionId)
      const explicitActiveProject = s.activeProjectId
        ? (s.projects.find((project) => project.id === s.activeProjectId) ?? null)
        : null
      const fallbackHomeProject =
        explicitActiveProject ??
        s.projects.find((project) => !project.pluginId) ??
        s.projects[0] ??
        null
      const activeProject = explicitActiveProject ?? fallbackHomeProject
      return {
        activeProjectId: activeSession?.projectId ?? s.activeProjectId ?? null,
        activeProjectName: activeProject?.name ?? null,
        activeProjectWorkingFolder: activeProject?.workingFolder ?? null,
        activeSessionProjectId: activeSession?.projectId ?? null,
        activeSessionTitle: activeSession?.title ?? null,
        activeSessionMode: activeSession?.mode as SessionMode | undefined
      }
    })
  )
  const {
    activeProjectId,
    activeProjectName,
    activeProjectWorkingFolder,
    activeSessionProjectId,
    activeSessionTitle,
    activeSessionMode
  } = activeSessionView
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const updateSessionMode = useChatStore((s) => s.updateSessionMode)
  const streamingMessageId = useChatStore((s) => s.streamingMessageId)
  const { pendingApproval, pendingApprovalCount: pendingToolCallCount } = useAgentStore(
    useShallow((s) => selectSessionPendingApproval(s, activeSessionId))
  )
  const resolveApproval = useAgentStore((s) => s.resolveApproval)
  const initBackgroundProcessTracking = useAgentStore((s) => s.initBackgroundProcessTracking)

  const { resolvedTheme, setTheme: ntSetTheme } = useTheme()
  const { stopStreaming } = useChatActions()
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth
  )
  const autoCollapsedSidebarForCrowdingRef = useRef(false)

  const runningSubAgentNamesSig = useAgentStore((s) => s.runningSubAgentNamesSig)
  const runningSubAgentCount = runningSubAgentNamesSig
    ? runningSubAgentNamesSig.split('\u0000').length
    : 0
  const runningSubAgentLabel = runningSubAgentNamesSig
    ? runningSubAgentNamesSig.split('\u0000').join(', ')
    : ''

  const shouldUseStaticWindowTitle = import.meta.env.MODE === 'test' || navigator.webdriver

  const handleModeChange = useCallback(
    (nextMode: AppMode): void => {
      setMode(nextMode)
      if (chatView === 'session' && activeSessionId) {
        updateSessionMode(activeSessionId, nextMode)
      }
    },
    [activeSessionId, chatView, setMode, updateSessionMode]
  )

  const handleCreateChatSession = useCallback((): void => {
    const store = useChatStore.getState()
    const uiStore = useUIStore.getState()
    store.setActiveProject(null)
    uiStore.setMode('chat')
    uiStore.navigateToHome()
  }, [])

  const handleImportSessions = useCallback((): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const data = JSON.parse(text)
        const sessions = Array.isArray(data) ? data : [data]
        const store = useChatStore.getState()
        let imported = 0
        for (const session of sessions) {
          if (session && session.id && Array.isArray(session.messages)) {
            const exists = store.sessions.some((existing) => existing.id === session.id)
            if (!exists) {
              store.restoreSession(session)
              imported++
            }
          }
        }
        if (imported > 0) {
          toast.success(t('layout.importedSessions', { count: imported }))
        } else {
          toast.info(t('layout.noNewSessions'))
        }
      } catch (err) {
        toast.error(
          t('layout.importFailed', { error: err instanceof Error ? err.message : String(err) })
        )
      }
    }
    input.click()
  }, [t])

  useEffect(() => {
    const disposers = [
      registerWorkbenchAction({
        id: 'workspace.open-tasks',
        title: t('commandPalette.openTasks', { defaultValue: 'Open tasks' }),
        keywords: ['tasks', 'kanban', 'gantt'],
        group: t('commandPalette.actions'),
        run: () => useUIStore.getState().openTasksPage()
      }),
      registerWorkbenchAction({
        id: 'workspace.import-sessions',
        title: t('commandPalette.importSessions'),
        keywords: ['import', 'restore', 'backup', 'json'],
        group: t('commandPalette.actions'),
        shortcut: 'Ctrl+Shift+O',
        run: handleImportSessions
      }),
      registerWorkbenchAction({
        id: 'workspace.toggle-auto-approve',
        title: t('shortcuts.toggleAutoApprove', { ns: 'settings' }),
        keywords: ['tools', 'approve', 'permission'],
        group: t('commandPalette.actions'),
        shortcut: 'Ctrl+Shift+A',
        run: async () => {
          const current = useSettingsStore.getState().autoApprove
          if (!current) {
            const confirmed = await confirm({ title: t('layout.autoApproveConfirm') })
            if (!confirmed) return
          }
          useSettingsStore.getState().updateSettings({ autoApprove: !current })
          toast.success(current ? t('layout.autoApproveOff') : t('layout.autoApproveOn'))
        }
      }),
      registerWorkbenchAction({
        id: 'workspace.delete-all-sessions',
        title: t('shortcuts.deleteAllSessions', { ns: 'settings' }),
        keywords: ['delete', 'clear', 'all', 'sessions'],
        group: t('commandPalette.actions'),
        shortcut: 'Ctrl+Shift+Del',
        enabledWhen: () => useChatStore.getState().sessions.length > 0,
        run: async () => {
          const store = useChatStore.getState()
          const count = store.sessions.length
          if (count === 0) return
          const confirmed = await confirm({
            title: t('layout.deleteAllConfirm', { count }),
            variant: 'destructive'
          })
          if (!confirmed) return
          store.clearAllSessions()
          toast.success(t('layout.deletedSessions', { count }))
        }
      }),
      registerWorkbenchAction({
        id: 'workspace.backup-sessions',
        title: t('shortcuts.backupSessions', { ns: 'settings' }),
        keywords: ['backup', 'export', 'json', 'sessions'],
        group: t('commandPalette.actions'),
        shortcut: 'Ctrl+Shift+S',
        run: async () => {
          const sessions = useChatStore.getState().sessions
          if (sessions.length === 0) {
            toast.error(t('layout.noSessionsToBackup'))
            return
          }
          try {
            const latestSessions = await Promise.all(sessions.map(exportSessionSnapshotFromDb))
            const blob = new Blob([JSON.stringify(latestSessions, null, 2)], {
              type: 'application/json'
            })
            const url = URL.createObjectURL(blob)
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = `ola-backup-${new Date().toISOString().slice(0, 10)}.json`
            anchor.click()
            URL.revokeObjectURL(url)
            toast.success(t('layout.backedUpSessions', { count: latestSessions.length }))
          } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error))
          }
        }
      }),
      registerWorkbenchAction({
        id: 'workspace.new-chat',
        title: t('commandPalette.newChat'),
        keywords: ['new', 'chat', 'conversation'],
        group: t('commandPalette.actions'),
        shortcut: 'Ctrl+N',
        run: handleCreateChatSession
      }),
      ...(
        [
          {
            id: 'mode.switch-chat',
            value: 'chat' as const,
            shortcut: 'Ctrl+1',
            title: 'switchToChat'
          },
          {
            id: 'mode.switch-clarify',
            value: 'clarify' as const,
            shortcut: 'Ctrl+2',
            title: 'switchToClarify'
          },
          {
            id: 'mode.switch-execute',
            value: 'execute' as const,
            shortcut: 'Ctrl+3',
            title: 'switchToExecute'
          },
          { id: 'mode.switch-acp', value: 'acp' as const, shortcut: 'Ctrl+4', title: 'switchToAcp' }
        ] as const
      ).map((item) =>
        registerWorkbenchAction({
          id: item.id,
          title: t(`commandPalette.${item.title}`),
          keywords: ['mode', item.value],
          group: t('commandPalette.switchMode'),
          shortcut: item.shortcut,
          enabledWhen: () => useUIStore.getState().mode !== item.value,
          run: () => handleModeChange(item.value)
        })
      ),
      registerWorkbenchAction({
        id: 'workspace.open-settings',
        title: t('commandPalette.openSettings'),
        keywords: ['settings', 'preferences'],
        group: t('commandPalette.actions'),
        shortcut: 'Ctrl+,',
        run: () => useUIStore.getState().openSettingsPage()
      }),
      registerWorkbenchAction({
        id: 'workspace.show-shortcuts',
        title: t('commandPalette.keyboardShortcuts'),
        keywords: ['keyboard', 'shortcuts', 'help'],
        group: t('commandPalette.actions'),
        shortcut: 'Ctrl+/',
        run: () => useUIStore.getState().setShortcutsOpen(true)
      }),
      registerWorkbenchAction({
        id: 'workspace.toggle-theme',
        title: t('commandPalette.toggleTheme'),
        keywords: ['theme', 'dark', 'light'],
        group: t('commandPalette.actions'),
        shortcut: 'Ctrl+Shift+D',
        run: () => {
          const next = resolvedTheme === 'dark' ? 'light' : 'dark'
          useSettingsStore.getState().updateSettings({ theme: next })
          ntSetTheme(next)
        }
      }),
      registerWorkbenchAction({
        id: 'workspace.toggle-sidebar',
        title: t('commandPalette.toggleSidebar'),
        keywords: ['sidebar', 'navigation'],
        group: t('commandPalette.actions'),
        shortcut: 'Ctrl+B',
        run: () => useUIStore.getState().toggleLeftSidebar()
      }),
      registerWorkbenchAction({
        id: 'workspace.toggle-right-panel',
        title: t('shortcuts.toggleRightPanel', { ns: 'settings' }),
        keywords: ['panel', 'preview', 'details'],
        group: t('shortcuts.navigation', { ns: 'settings' }),
        shortcut: 'Ctrl+Shift+B',
        run: () => useUIStore.getState().toggleRightPanel()
      }),
      registerWorkbenchAction({
        id: 'workspace.open-command-palette',
        title: t('commandPalette.title', { defaultValue: 'Command palette' }),
        keywords: ['command', 'search', 'actions'],
        group: t('commandPalette.actions'),
        shortcut: 'Ctrl+K',
        showInPalette: false,
        run: () => {
          const ui = useUIStore.getState()
          ui.setCommandPaletteOpen(!ui.commandPaletteOpen)
        }
      })
    ]
    return () => disposers.forEach((dispose) => dispose())
  }, [
    handleCreateChatSession,
    handleImportSessions,
    handleModeChange,
    ntSetTheme,
    resolvedTheme,
    t
  ])

  useEffect(() => {
    void initBackgroundProcessTracking()
  }, [initBackgroundProcessTracking])

  useEffect(() => {
    const handleResize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    handleResize()
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    const openRightSidePanelCount = Number(rightPanelOpen) + Number(workingFolderSheetOpen)
    const rightSideWidth =
      (rightPanelOpen ? rightPanelWidth : 0) +
      (workingFolderSheetOpen ? workingFolderPanelWidth : 0)
    const widthLeftForMainWorkspace =
      viewportWidth - rightSideWidth - (leftSidebarOpen ? leftSidebarWidth : 0)
    const rightSidePanelsNeedSpace =
      openRightSidePanelCount >= 2 && viewportWidth < MULTI_RIGHT_PANEL_COLLAPSE_VIEWPORT
    const narrowViewport = viewportWidth < MIN_VIEWPORT_WIDTH_WITH_SIDEBAR
    const mainWorkspaceTooNarrow =
      openRightSidePanelCount > 0 &&
      widthLeftForMainWorkspace < MIN_MAIN_WORKSPACE_WIDTH_WITH_SIDEBAR
    const shouldCollapseSidebar =
      (chatView === 'session' || tasksPageOpen) &&
      leftSidebarOpen &&
      (narrowViewport || rightSidePanelsNeedSpace || mainWorkspaceTooNarrow)

    if (!shouldCollapseSidebar) {
      if (
        !narrowViewport &&
        (openRightSidePanelCount === 0 || viewportWidth >= MULTI_RIGHT_PANEL_COLLAPSE_VIEWPORT)
      ) {
        autoCollapsedSidebarForCrowdingRef.current = false
      }
      return
    }

    if (autoCollapsedSidebarForCrowdingRef.current) return
    autoCollapsedSidebarForCrowdingRef.current = true
    setLeftSidebarOpen(false)
  }, [
    chatView,
    leftSidebarOpen,
    leftSidebarWidth,
    rightPanelOpen,
    rightPanelWidth,
    setLeftSidebarOpen,
    tasksPageOpen,
    viewportWidth,
    workingFolderPanelWidth,
    workingFolderSheetOpen
  ])

  // Update window title (show pending approvals + streaming state + SubAgent)
  useEffect(() => {
    if (shouldUseStaticWindowTitle) {
      document.title = 'Ola'
      return
    }

    const base = activeSessionTitle ? `${activeSessionTitle} — Ola` : 'Ola'
    const prefix =
      pendingToolCallCount > 0
        ? `(${pendingToolCallCount} pending) `
        : runningSubAgentCount > 0
          ? `🧠 ${runningSubAgentLabel} | `
          : streamingMessageId
            ? '⏳ '
            : ''
    document.title = `${prefix}${base}`
  }, [
    activeSessionTitle,
    pendingToolCallCount,
    runningSubAgentCount,
    runningSubAgentLabel,
    shouldUseStaticWindowTitle,
    streamingMessageId
  ])

  // Sync UI mode only when session info changes, so manual top-bar toggles are respected
  useEffect(() => {
    if (!activeSessionMode) return
    const normalizedSessionMode: AppMode = activeSessionMode
    const currentMode = useUIStore.getState().mode
    if (currentMode !== normalizedSessionMode) {
      queueMicrotask(() => {
        if (useUIStore.getState().mode !== normalizedSessionMode) {
          useUIStore.getState().setMode(normalizedSessionMode)
        }
      })
    }
  }, [activeSessionId, activeSessionMode, activeSessionProjectId])

  useEffect(() => {
    if (chatView !== 'session' || activeSessionId) return
    if (activeProjectId) {
      useUIStore.getState().navigateToProject()
      return
    }
    useUIStore.getState().navigateToHome()
  }, [activeProjectId, activeSessionId, chatView])

  // Close detail panel when switching sessions
  const prevActiveSessionRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevActiveSessionRef.current
    prevActiveSessionRef.current = activeSessionId
    if (prev !== null && prev !== activeSessionId) {
      useUIStore.getState().closeDetailPanel()
      useUIStore.getState().closeSubAgentExecutionDetail()
    }
  }, [activeSessionId])

  const settingsPageOpen = activeSurface === 'settings'
  const usagePageOpen = activeSurface === 'usage'
  const petStudioPageOpen = activeSurface === 'petStudio'
  const accountAuthPageOpen = activeSurface === 'account'
  const conversationGuideOpen = useUIStore((s) => s.conversationGuideOpen)
  const setConversationGuideOpen = useUIStore((s) => s.setConversationGuideOpen)
  const skillsPageOpen = activeSurface === 'capabilities'
  const soulsPageOpen = activeSurface === 'personalization'
  const syncPageOpen = activeSurface === 'data'
  const resourcesPageOpen = activeSurface === 'resources'
  const drawPageOpen = activeSurface === 'draw'
  const translatePageOpen = activeSurface === 'translate'
  const splitSession = useChatStore((s) =>
    splitSessionId ? s.sessions.find((session) => session.id === splitSessionId) : null
  )
  const activeWorkspaceSessionIds = useChatStore(
    useShallow((s) =>
      s.sessions
        .filter((session) => (session.workspaceId ?? 'local-personal') === activeWorkspaceId)
        .map((session) => session.id)
    )
  )
  const activeWorkspaceSessions = useMemo(
    () => new Set(activeWorkspaceSessionIds),
    [activeWorkspaceSessionIds]
  )

  useEffect(() => {
    if (!splitSessionId || !splitSession || splitSessionId === activeSessionId) {
      if (splitSessionId) closeWorkspaceSplit(activeWorkspaceId)
    }
  }, [activeSessionId, activeWorkspaceId, closeWorkspaceSplit, splitSession, splitSessionId])
  const contentHeader = useMemo(() => {
    if (tasksPageOpen) {
      return { title: t('navRail.tasks', { defaultValue: 'Tasks' }), subtitle: null }
    }
    if (resourcesPageOpen) {
      return { title: t('navRail.resources', { defaultValue: 'Resources' }), subtitle: null }
    }
    if (skillsPageOpen) {
      return { title: t('navRail.skills', { defaultValue: 'Tools' }), subtitle: null }
    }
    if (soulsPageOpen) {
      return { title: t('navRail.souls', { defaultValue: 'SOUL' }), subtitle: null }
    }
    if (syncPageOpen) {
      return { title: t('navRail.sync', { defaultValue: 'Sync' }), subtitle: null }
    }
    if (settingsPageOpen) {
      return { title: t('navRail.settings', { defaultValue: 'Settings' }), subtitle: null }
    }
    if (drawPageOpen) {
      return { title: t('navRail.draw', { defaultValue: 'Drawing' }), subtitle: null }
    }
    if (translatePageOpen) {
      return { title: t('navRail.translate', { defaultValue: 'Translate' }), subtitle: null }
    }
    if (chatView === 'project') {
      return {
        title: activeProjectName ?? t('sidebar.projects', { defaultValue: 'Projects' }),
        subtitle: null,
        tooltip: activeProjectWorkingFolder
      }
    }
    if (chatView === 'archive') {
      return {
        title: t('sidebar.projectArchive', { defaultValue: 'Project archive' }),
        subtitle: null,
        tooltip: activeProjectWorkingFolder
      }
    }
    if (chatView === 'channels') {
      return {
        title: t('sidebar.projectChannels', { defaultValue: 'Channels' }),
        subtitle: null,
        tooltip: activeProjectWorkingFolder
      }
    }
    if (chatView === 'git') {
      return {
        title: t('sidebar.projectGit', { defaultValue: 'Git' }),
        subtitle: null,
        tooltip: activeProjectWorkingFolder
      }
    }
    if (chatView === 'session') {
      return {
        title: '',
        subtitle: null,
        tooltip: null
      }
    }
    return {
      title: t('sidebar.newChat', { defaultValue: 'New Chat' }),
      subtitle: null,
      tooltip: mode !== 'chat' ? activeProjectWorkingFolder : null
    }
  }, [
    activeProjectName,
    activeProjectWorkingFolder,
    chatView,
    drawPageOpen,
    mode,
    resourcesPageOpen,
    settingsPageOpen,
    skillsPageOpen,
    soulsPageOpen,
    syncPageOpen,
    t,
    tasksPageOpen,
    translatePageOpen
  ])

  useEffect(() => {
    const currentSessionId = (): string | null => useChatStore.getState().activeSessionId
    const currentSession = () => {
      const store = useChatStore.getState()
      return store.sessions.find((session) => session.id === store.activeSessionId)
    }
    const group = t('commandPalette.currentSession')
    const disposers = [
      registerWorkbenchAction({
        id: 'session.duplicate',
        title: t('shortcuts.duplicateSession', { ns: 'settings' }),
        keywords: ['duplicate', 'copy', 'session'],
        group,
        shortcut: 'Ctrl+D',
        enabledWhen: () => Boolean(currentSession()),
        run: () => {
          const sessionId = currentSessionId()
          if (!sessionId) return
          useChatStore.getState().duplicateSession(sessionId)
          toast.success(t('layout.sessionDuplicated'))
        }
      }),
      registerWorkbenchAction({
        id: 'session.toggle-pin',
        title: t('shortcuts.pinUnpinSession', { ns: 'settings' }),
        keywords: ['pin', 'unpin', 'session'],
        group,
        shortcut: 'Ctrl+P',
        enabledWhen: () => Boolean(currentSession()),
        run: () => {
          const session = currentSession()
          if (!session) return
          useChatStore.getState().togglePinSession(session.id)
          toast.success(session.pinned ? t('layout.unpinned') : t('layout.pinned'))
        }
      }),
      registerWorkbenchAction({
        id: 'session.clear-messages',
        title: t('shortcuts.clearConversation', { ns: 'settings' }),
        keywords: ['clear', 'messages', 'conversation'],
        group,
        shortcut: 'Ctrl+L',
        enabledWhen: () => Boolean(currentSession()),
        run: async () => {
          const session = currentSession()
          if (!session) return
          if (session.messageCount > 0) {
            const confirmed = await confirm({
              title: t('layout.clearConfirm', { count: session.messageCount }),
              variant: 'destructive'
            })
            if (!confirmed) return
          }
          if (!(await useChatStore.getState().clearSessionMessages(session.id))) return
          if (session.messageCount > 0) toast.success(t('layout.conversationCleared'))
        }
      }),
      registerWorkbenchAction({
        id: 'session.export-markdown',
        title: t('commandPalette.exportCurrentChat'),
        keywords: ['export', 'markdown', 'conversation'],
        group,
        shortcut: 'Ctrl+Shift+E',
        enabledWhen: () => Boolean(currentSession()?.messageCount),
        run: async () => {
          const session = currentSession()
          if (!session?.messageCount) return
          try {
            const markdown = await exportSessionMarkdownFromDb(session)
            const filename =
              session.title
                .replace(/[^a-zA-Z0-9-_ ]/g, '')
                .slice(0, 50)
                .trim() || 'conversation'
            const blob = new Blob([markdown], { type: 'text/markdown' })
            const url = URL.createObjectURL(blob)
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = `${filename}.md`
            anchor.click()
            URL.revokeObjectURL(url)
            toast.success(t('layout.exportedConversation'))
          } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error))
          }
        }
      }),
      registerWorkbenchAction({
        id: 'session.copy-markdown',
        title: t('shortcuts.copyConversation', { ns: 'settings' }),
        keywords: ['copy', 'markdown', 'clipboard', 'conversation'],
        group,
        shortcut: 'Ctrl+Shift+C',
        enabledWhen: () => Boolean(currentSession()?.messageCount),
        run: async () => {
          const session = currentSession()
          if (!session?.messageCount) return
          try {
            const markdown = await exportSessionMarkdownFromDb(session)
            await navigator.clipboard.writeText(markdown)
            toast.success(t('layout.conversationCopied'))
          } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error))
          }
        }
      }),
      registerWorkbenchAction({
        id: 'session.delete-current',
        title: t('commandPalette.deleteCurrentSession'),
        keywords: ['delete', 'remove', 'session'],
        group,
        enabledWhen: () => {
          const session = currentSession()
          if (!session) return false
          const workspaceId = useWorkspaceStore.getState().activeWorkspaceId
          return (
            useChatStore
              .getState()
              .sessions.filter((item) => (item.workspaceId ?? 'local-personal') === workspaceId)
              .length > 1
          )
        },
        run: async () => {
          const sessionId = currentSessionId()
          if (!sessionId) return
          abortSession(sessionId)
          if (!(await useChatStore.getState().deleteSession(sessionId))) {
            toast.error(t('sidebar_toast.deleteFailed'))
          } else {
            clearPendingSessionMessages(sessionId)
          }
        }
      }),
      ...(
        [
          {
            id: 'session.previous',
            title: t('shortcuts.previousSession', { ns: 'settings' }),
            shortcut: 'Ctrl+↑',
            direction: -1 as const
          },
          {
            id: 'session.next',
            title: t('shortcuts.nextSession', { ns: 'settings' }),
            shortcut: 'Ctrl+↓',
            direction: 1 as const
          }
        ] as const
      ).map((item) =>
        registerWorkbenchAction({
          id: item.id,
          title: item.title,
          keywords: ['navigate', 'switch', 'session'],
          group: t('shortcuts.navigation', { ns: 'settings' }),
          shortcut: item.shortcut,
          enabledWhen: () => {
            const workspaceId = useWorkspaceStore.getState().activeWorkspaceId
            return (
              useChatStore
                .getState()
                .sessions.filter(
                  (session) => (session.workspaceId ?? 'local-personal') === workspaceId
                ).length > 1
            )
          },
          run: () => {
            const store = useChatStore.getState()
            const workspaceId = useWorkspaceStore.getState().activeWorkspaceId
            const sessions = store.sessions
              .filter((session) => (session.workspaceId ?? 'local-personal') === workspaceId)
              .sort((a, b) => {
                if (a.pinned && !b.pinned) return -1
                if (!a.pinned && b.pinned) return 1
                return b.updatedAt - a.updatedAt
              })
            if (sessions.length < 2) return
            const index = sessions.findIndex((session) => session.id === store.activeSessionId)
            const nextIndex = (index + item.direction + sessions.length) % sessions.length
            void openSessionOrFocusDetached(sessions[nextIndex].id)
          }
        })
      ),
      ...(
        [
          {
            id: 'conversation.scroll-top',
            title: t('shortcuts.scrollTop', { ns: 'settings' }),
            key: 'Home',
            shortcut: 'Ctrl+Home'
          },
          {
            id: 'conversation.scroll-bottom',
            title: t('shortcuts.scrollBottom', { ns: 'settings' }),
            key: 'End',
            shortcut: 'Ctrl+End'
          }
        ] as const
      ).map((item) =>
        registerWorkbenchAction({
          id: item.id,
          title: item.title,
          keywords: ['scroll', 'conversation', 'messages'],
          group: t('shortcuts.chatGroup', { ns: 'settings' }),
          shortcut: item.shortcut,
          run: () => {
            const container = document.querySelector('.overflow-y-auto')
            if (container) {
              container.scrollTo({
                top: item.key === 'Home' ? 0 : container.scrollHeight,
                behavior: 'smooth'
              })
            }
          }
        })
      ),
      registerWorkbenchAction({
        id: 'workspace.cycle-right-panel-tab',
        title: t('shortcuts.cycleRightTab', { ns: 'settings' }),
        keywords: ['panel', 'tab', 'cycle', 'right'],
        group: t('shortcuts.navigation', { ns: 'settings' }),
        shortcut: 'Ctrl+Shift+T',
        run: () => {
          const ui = useUIStore.getState()
          if (!ui.rightPanelOpen) {
            ui.setRightPanelOpen(true)
            return
          }
          const tabs = ui.rightPanelTabs
          if (tabs.length === 0) {
            ui.setRightPanelOpen(true)
            return
          }
          const index = tabs.findIndex((tab) => tab.id === ui.rightPanelActiveTabId)
          const next = tabs[((index >= 0 ? index : 0) + 1) % tabs.length]
          if (next) ui.setRightPanelActiveTab(next.id)
        }
      }),
      registerWorkbenchAction({
        id: 'conversation.stop-streaming',
        title: t('shortcuts.stopStreaming', { ns: 'settings' }),
        keywords: ['stop', 'cancel', 'generation'],
        group: t('shortcuts.chatGroup', { ns: 'settings' }),
        shortcut: 'Escape',
        run: stopStreaming
      })
    ]
    return () => disposers.forEach((dispose) => dispose())
  }, [activeSessionId, stopStreaming, t])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent): Promise<void> => {
      // Ctrl+Shift+N: New independent chat session
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
        e.preventDefault()
        runWorkbenchAction('workspace.new-chat')
        return
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        runWorkbenchAction('workspace.open-command-palette')
        return
      }
      // Ctrl+1/2/3/4: Switch mode
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault()
        const modeActionId = {
          '1': 'mode.switch-chat',
          '2': 'mode.switch-clarify',
          '3': 'mode.switch-execute',
          '4': 'mode.switch-acp'
        } as const
        runWorkbenchAction(modeActionId[e.key as keyof typeof modeActionId])
      }
      // Ctrl+N: New independent chat session
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        runWorkbenchAction('workspace.new-chat')
      }
      // Ctrl+,: Open settings
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        runWorkbenchAction('workspace.open-settings')
      }
      // Ctrl+B: Toggle left sidebar
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'b') {
        e.preventDefault()
        runWorkbenchAction('workspace.toggle-sidebar')
      }
      // Ctrl+Shift+B: Toggle right panel
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'B') {
        e.preventDefault()
        runWorkbenchAction('workspace.toggle-right-panel')
      }
      // Ctrl+L: Clear current conversation
      if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
        e.preventDefault()
        runWorkbenchAction('session.clear-messages')
      }
      // Ctrl+D: Duplicate current session
      if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
        e.preventDefault()
        runWorkbenchAction('session.duplicate')
      }
      // Ctrl+P: Pin/unpin current session
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault()
        runWorkbenchAction('session.toggle-pin')
      }
      // Ctrl+Up/Down: Navigate between sessions
      if ((e.metaKey || e.ctrlKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        runWorkbenchAction(e.key === 'ArrowDown' ? 'session.next' : 'session.previous')
      }
      // Ctrl+Home/End: Scroll to top/bottom of messages
      if ((e.metaKey || e.ctrlKey) && (e.key === 'Home' || e.key === 'End')) {
        e.preventDefault()
        runWorkbenchAction(
          e.key === 'Home' ? 'conversation.scroll-top' : 'conversation.scroll-bottom'
        )
      }
      // Escape: Stop streaming
      if (e.key === 'Escape' && streamingMessageId) {
        e.preventDefault()
        runWorkbenchAction('conversation.stop-streaming')
      }
      // Ctrl+/: Keyboard shortcuts
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault()
        runWorkbenchAction('workspace.show-shortcuts')
      }
      // Ctrl+Shift+C: Copy conversation as markdown
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        e.preventDefault()
        runWorkbenchAction('session.copy-markdown')
        return
      }
      // Ctrl+Shift+A: Toggle auto-approve tools
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault()
        runWorkbenchAction('workspace.toggle-auto-approve')
        return
      }
      // Ctrl+Shift+Delete: Clear all sessions
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Delete') {
        e.preventDefault()
        runWorkbenchAction('workspace.delete-all-sessions')
        return
      }
      // Ctrl+Shift+T: Cycle right panel tab forward
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'T' || e.key === 't')) {
        e.preventDefault()
        runWorkbenchAction('workspace.cycle-right-panel-tab')
        return
      }
      // Ctrl+Shift+D: Toggle dark/light theme
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault()
        const current = resolvedTheme
        const next = current === 'dark' ? 'light' : 'dark'
        runWorkbenchAction('workspace.toggle-theme')
        toast.success(`${t('layout.theme')}: ${next}`)
        return
      }
      // Ctrl+Shift+O: Import sessions from JSON backup
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
        e.preventDefault()
        runWorkbenchAction('workspace.import-sessions')
        return
      }
      // Ctrl+Shift+S: Backup all sessions as JSON
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'S' || e.key === 's')) {
        e.preventDefault()
        runWorkbenchAction('workspace.backup-sessions')
        return
      }
      // Ctrl+Shift+E: Export current conversation
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'E') {
        e.preventDefault()
        runWorkbenchAction('session.export-markdown')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeSessionId, resolvedTheme, streamingMessageId, t])

  const showEmbeddedSidebar =
    leftSidebarOpen && !settingsPageOpen && !usagePageOpen && !petStudioPageOpen
  const mainContent = accountAuthPageOpen ? (
    <div className="h-screen overflow-hidden bg-background">
      <PageTransition
        key="account-auth-page-shell"
        className="h-full min-h-0 w-full overflow-hidden"
      >
        <AccountAuthPage />
      </PageTransition>
    </div>
  ) : settingsPageOpen ? (
    <div className="h-screen overflow-hidden bg-background">
      <PageTransition key="settings-page-shell" className="h-full min-h-0 w-full overflow-hidden">
        <Suspense fallback={<LazyPageFallback />}>
          <SettingsPage />
        </Suspense>
      </PageTransition>
    </div>
  ) : usagePageOpen ? (
    <div className="h-screen overflow-hidden bg-background">
      <PageTransition key="usage-page-shell" className="h-full min-h-0 w-full overflow-hidden">
        <UsagePage />
      </PageTransition>
    </div>
  ) : petStudioPageOpen ? (
    <div className="h-screen overflow-hidden bg-background">
      <PageTransition key="pet-studio-page-shell" className="h-full min-h-0 w-full overflow-hidden">
        <PetStudioPage />
      </PageTransition>
    </div>
  ) : (
    <div className="flex h-screen overflow-hidden bg-background">
      <AnimatePresence>
        {showEmbeddedSidebar && (
          <PanelTransition side="left" disabled={false} className="z-10 h-full shrink-0">
            <WorkspaceSidebar />
          </PanelTransition>
        )}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <TitleBar
          updateInfo={updateInfo}
          onOpenUpdateDialog={onOpenUpdateDialog}
          title={contentHeader.title}
          subtitle={contentHeader.subtitle}
          tooltip={contentHeader.tooltip}
          showSidebarToggle={!showEmbeddedSidebar}
          insetForMacTrafficLights={!showEmbeddedSidebar}
        />

        {activeSurface === 'workspace' && <WorkspaceTabStrip />}
        {activeSurface === 'workspace' && <SessionTabStrip />}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <AnimatePresence mode="wait">
            {tasksPageOpen ? (
              <PageTransition
                key="tasks-page"
                className="flex-1 min-w-0 bg-background overflow-hidden"
              >
                <Suspense fallback={<LazyPageFallback />}>
                  <TasksPage />
                </Suspense>
              </PageTransition>
            ) : resourcesPageOpen ? (
              <PageTransition
                key="resources-page"
                className="flex-1 min-w-0 bg-background overflow-hidden"
              >
                <Suspense fallback={<LazyPageFallback />}>
                  <ResourcesPage />
                </Suspense>
              </PageTransition>
            ) : skillsPageOpen ? (
              <PageTransition
                key="skills-page"
                className="flex-1 min-w-0 bg-background overflow-hidden"
              >
                <Suspense fallback={<LazyPageFallback />}>
                  <SkillsPage />
                </Suspense>
              </PageTransition>
            ) : soulsPageOpen ? (
              <PageTransition
                key="souls-page"
                className="flex-1 min-w-0 bg-background overflow-hidden"
              >
                <Suspense fallback={<LazyPageFallback />}>
                  <SoulsPage />
                </Suspense>
              </PageTransition>
            ) : syncPageOpen ? (
              <PageTransition
                key="sync-page"
                className="flex-1 min-w-0 bg-background overflow-hidden"
              >
                <Suspense fallback={<LazyPageFallback />}>
                  <SyncPage />
                </Suspense>
              </PageTransition>
            ) : drawPageOpen ? (
              <PageTransition
                key="draw-page"
                className="flex-1 min-w-0 bg-background overflow-hidden"
              >
                <Suspense fallback={<LazyPageFallback />}>
                  <DrawPage />
                </Suspense>
              </PageTransition>
            ) : translatePageOpen ? (
              <PageTransition
                key="translate-page"
                className="flex-1 min-w-0 bg-background overflow-hidden"
              >
                <Suspense fallback={<LazyPageFallback />}>
                  <TranslatePage />
                </Suspense>
              </PageTransition>
            ) : chatView === 'home' || chatView === 'project' ? (
              <PageTransition
                key="workspace-home"
                className="flex flex-1 min-w-0 flex-col overflow-hidden"
              >
                <WorkspaceHome />
              </PageTransition>
            ) : chatView === 'archive' || chatView === 'channels' ? (
              <PageTransition
                key={chatView === 'channels' ? 'project-channels' : 'project-archive'}
                className="flex flex-1 min-w-0 flex-col overflow-hidden"
              >
                <ProjectArchivePage />
              </PageTransition>
            ) : chatView === 'git' ? (
              <PageTransition
                key="project-git"
                className="flex flex-1 min-w-0 flex-col overflow-hidden"
              >
                <GitPage />
              </PageTransition>
            ) : (
              <PageTransition
                key="main-layout"
                className="flex flex-1 min-w-0 flex-col overflow-hidden"
              >
                <ErrorBoundary
                  renderFallback={(error, reset) => (
                    <div className="flex flex-1 flex-col items-center justify-center gap-4 overflow-hidden p-8 text-center">
                      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
                        <svg
                          className="size-6 text-destructive"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
                          />
                        </svg>
                      </div>
                      <div className="space-y-1">
                        <h3 className="text-sm font-semibold text-foreground">
                          {t('layout.somethingWentWrong')}
                        </h3>
                        <p className="max-w-md text-xs text-muted-foreground">
                          {error?.message || t('layout.unexpectedError')}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                          onClick={reset}
                        >
                          {t('layout.tryAgain')}
                        </button>
                        <button
                          className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          onClick={() => window.location.reload()}
                        >
                          {t('layout.reloadApp')}
                        </button>
                        <button
                          className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          onClick={() => {
                            const text = `Error: ${error?.message}\nStack: ${error?.stack}`
                            navigator.clipboard.writeText(text)
                          }}
                        >
                          {t('layout.copyError')}
                        </button>
                      </div>
                      {error?.stack && (
                        <details className="w-full max-w-lg text-left">
                          <summary className="cursor-pointer text-[10px] text-muted-foreground transition-colors hover:text-foreground">
                            {t('layout.errorDetails')}
                          </summary>
                          <pre className="mt-1 max-h-32 overflow-auto rounded-md bg-muted p-2 text-[10px] leading-relaxed text-muted-foreground">
                            {error.stack}
                          </pre>
                        </details>
                      )}
                    </div>
                  )}
                >
                  <div className="flex flex-1 overflow-hidden">
                    <div
                      className="flex min-w-0 flex-1 overflow-hidden"
                      onDragOver={(event) => {
                        if (event.dataTransfer.types.includes('text/session-tab')) {
                          event.preventDefault()
                          event.dataTransfer.dropEffect = 'copy'
                        }
                      }}
                      onDrop={(event) => {
                        const sessionId = event.dataTransfer.getData('text/session-tab')
                        if (!sessionId) return
                        event.preventDefault()
                        if (activeWorkspaceSessions.has(sessionId)) {
                          openWorkspaceSplit(activeWorkspaceId, sessionId, activeSessionId)
                        }
                      }}
                    >
                      <SessionConversationPane windowHeaderOwnsTitle />
                      {splitSession && splitSession.id !== activeSessionId ? (
                        <>
                          <div
                            role="separator"
                            aria-label={t('layout.splitConversation', {
                              defaultValue: 'Split conversation'
                            })}
                            className="w-px shrink-0 bg-border/70"
                          />
                          <div className="relative flex min-w-0 flex-1 overflow-hidden">
                            <SessionConversationPane
                              sessionId={splitSession.id}
                              allowOpenInNewWindow
                              windowHeaderOwnsTitle
                            />
                            <button
                              type="button"
                              aria-label={t('layout.closeSplitConversation', {
                                defaultValue: 'Close split conversation'
                              })}
                              title={t('layout.closeSplitConversation', {
                                defaultValue: 'Close split conversation'
                              })}
                              onClick={() => closeWorkspaceSplit(activeWorkspaceId)}
                              className="absolute right-2 top-2 z-10 rounded-md border border-border/60 bg-background/90 p-1 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
                            >
                              <X className="size-3.5" aria-hidden="true" />
                            </button>
                          </div>
                        </>
                      ) : null}
                    </div>
                    <WorkingFolderSheet />
                    <RightPanel />
                  </div>
                </ErrorBoundary>
              </PageTransition>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )

  return (
    <TooltipProvider delayDuration={0}>
      {mainContent}

      <Dialog
        open={subAgentExecutionDetailOpen}
        onOpenChange={(open) => {
          if (!open) closeSubAgentExecutionDetail()
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-[1400px] overflow-hidden p-0 sm:max-w-[1400px]"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>
              {t('subAgentsPanel.executionDetailTitle', { defaultValue: 'Execution details' })}
            </DialogTitle>
          </DialogHeader>
          <SubAgentExecutionDetail
            toolUseId={subAgentExecutionDetailToolUseId}
            inlineText={subAgentExecutionDetailInlineText ?? undefined}
            onClose={closeSubAgentExecutionDetail}
          />
        </DialogContent>
      </Dialog>

      <CommandPalette />
      <KeyboardShortcutsDialog />
      <ExtensionWorkbenchViewDialog />
      <ConversationGuideDialog
        open={conversationGuideOpen}
        onOpenChange={setConversationGuideOpen}
      />
      <PermissionDialog
        toolCall={pendingApproval}
        onAllow={() => pendingApproval && resolveApproval(pendingApproval.id, true)}
        onDeny={() => pendingApproval && resolveApproval(pendingApproval.id, false)}
      />
    </TooltipProvider>
  )
}
