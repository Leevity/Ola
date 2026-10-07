import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { useTranslation } from 'react-i18next'
import { Layout } from './components/layout/Layout'
import { DetachedSessionPage } from './components/layout/DetachedSessionPage'
import { RemotePage } from './components/remote/RemotePage'
import { OnboardingPage } from './components/onboarding/OnboardingPage'
import { Toaster } from './components/ui/sonner'
import { Button } from './components/ui/button'
import { ConfirmDialogProvider } from './components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './components/ui/dialog'
import { ThemeProvider } from './components/theme-provider'
import { ThemeRuntimeSync } from './components/theme-runtime-sync'
import { ErrorBoundary } from './components/error-boundary'
import { useSettingsStore } from './stores/settings-store'
import { useRemoteAccountStore } from './stores/remote-account-store'
import { initProviderStore, useProviderStore } from './stores/provider-store'
import { initAppPluginStore, useAppPluginStore } from './stores/app-plugin-store'
import { initExtensionStore } from './stores/extension-store'
import { useAgentStore } from './stores/agent-store'
import { useChatStore } from './stores/chat-store'
import { usePlanStore } from './stores/plan-store'
import { installGoalSyncListener, useGoalStore } from './stores/goal-store'
import { useSshStore } from './stores/ssh-store'
import { useTaskStore } from './stores/task-store'
import { useTaskBoardStore } from './stores/task-board-store'
import { useTeamStore } from './stores/team-store'
import { useUIStore } from './stores/ui-store'
import { useWorkspaceStore } from './stores/workspace-store'
import {
  registerAllTools,
  updateCanvasToolRegistration,
  updateVideoGenerationToolRegistration,
  updateWebSearchToolRegistration
} from './lib/tools'
import { updateAppPluginToolRegistration } from './lib/app-plugin'
import { refreshExtensionTools } from './lib/extensions/extension-tools'
import { refreshExtensionWorkbenchContributions } from './lib/extensions/extension-workbench'
import { registerAllViewers } from './lib/preview/register-viewers'
import {
  createMarkdownComponents,
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS
} from './lib/preview/viewers/markdown-components'
import { initChannelEventListener } from './stores/channel-store'
import { usePluginAutoReply } from './hooks/use-plugin-auto-reply'
import { toast } from 'sonner'
import i18n from './locales'
import { cronEvents } from './lib/tools/cron-events'
import { useCronStore, type CronAgentLogEntry } from './stores/cron-store'
import { isCronWorkspaceEventFor } from './lib/cron-workspace-event'
import { ipcClient } from './lib/ipc/ipc-client'
import { waitForSettingsWriteIdle } from './lib/ipc/ipc-storage'
import { IPC } from './lib/ipc/channels'
import { attachRendererToolBridge } from './lib/ipc/renderer-tool-bridge'
import { reattachActiveTsRuntimeRuns } from './lib/agent/runtime-reattach'
import {
  ensureWindowWorkspaceRegistered,
  invalidateWindowWorkspaceRegistration
} from './lib/window-workspace-registration'
import { nanoid } from 'nanoid'
import type { UnifiedMessage } from './lib/api/types'
import { NotifyToastContainer } from './components/notify/NotifyWindow'
import { ChangelogDialog } from './components/changelog/ChangelogDialog'
import {
  installAgentRuntimeSyncListener,
  withAgentRuntimeSyncSuppressed,
  type AgentRuntimeSyncEvent
} from './lib/agent-runtime-sync'
import { installSessionRuntimeSyncListener } from './lib/session-runtime-sync'
import { installRendererMemoryMonitor } from './lib/renderer-memory-monitor'
import {
  getGlobalMemorySnapshot,
  loadGlobalMemorySnapshot,
  subscribeGlobalMemoryUpdates,
  type GlobalMemorySnapshot
} from './lib/agent/memory-files'

// Register synchronous viewers immediately at startup
registerAllViewers()
initProviderStore()
initAppPluginStore()
attachRendererToolBridge()

// Register tools (async because SubAgents are loaded from .md files via IPC)
initExtensionStore()
  .then(() => registerAllTools())
  .catch((err) => console.error('[App] Failed to register tools:', err))

// Initialize channel incoming event listener
initChannelEventListener()

const GLOBAL_MEMORY_REMINDER_MARKER = '[global-memory-update]'
const RENDERER_OOM_RECOVERY_PARAM = 'ocRecoverRendererOom'
const globalMemoryVersionBySession = new Map<string, number>()

function normalizeVersion(version: string | null | undefined): string {
  return (version ?? '').trim().replace(/^v/i, '')
}

function compareVersions(left: string, right: string): number {
  const leftParts = normalizeVersion(left).split('-')[0].split('.')
  const rightParts = normalizeVersion(right).split('-')[0].split('.')
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const leftValue = Number.parseInt(leftParts[index] ?? '0', 10)
    const rightValue = Number.parseInt(rightParts[index] ?? '0', 10)
    const safeLeftValue = Number.isFinite(leftValue) ? leftValue : 0
    const safeRightValue = Number.isFinite(rightValue) ? rightValue : 0

    if (safeLeftValue !== safeRightValue) {
      return safeLeftValue > safeRightValue ? 1 : -1
    }
  }

  return 0
}

interface AvailableUpdate {
  currentVersion: string
  newVersion: string
  releaseNotes: string
}

function isSshWindowView(): boolean {
  const search = new URLSearchParams(window.location.search)
  return search.get('appView') === 'ssh'
}

function getAppView(): string | null {
  const search = new URLSearchParams(window.location.search)
  return search.get('appView')
}

function getDetachedSessionId(): string | null {
  const search = new URLSearchParams(window.location.search)
  return search.get('sessionId')
}

function consumeRendererOomRecoveryFlag(): boolean {
  const url = new URL(window.location.href)
  const shouldRecover = url.searchParams.get(RENDERER_OOM_RECOVERY_PARAM) === '1'
  if (!shouldRecover) return false

  url.searchParams.delete(RENDERER_OOM_RECOVERY_PARAM)
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  return true
}

function buildGlobalMemoryReminder(snapshot: GlobalMemorySnapshot): string {
  const pathLabel = snapshot.path ? `\`${snapshot.path}\`` : 'path unavailable'
  const timeLabel = snapshot.updatedAt
    ? new Date(snapshot.updatedAt).toLocaleString()
    : new Date().toLocaleString()
  const statusLine = snapshot.content
    ? `Global memory updated (${timeLabel}).`
    : `Global memory unavailable or empty (${timeLabel}).`
  return [
    '<system-reminder>',
    GLOBAL_MEMORY_REMINDER_MARKER,
    statusLine,
    `Path: ${pathLabel}`,
    '</system-reminder>'
  ].join('\n')
}

function upsertGlobalMemoryReminder(sessionId: string, snapshot: GlobalMemorySnapshot): void {
  const store = useChatStore.getState()
  const messages = store.getSessionMessages(sessionId)
  const reminder = buildGlobalMemoryReminder(snapshot)
  const existing = [...messages].reverse().find((msg) => {
    if (msg.role !== 'system') return false
    if (typeof msg.content !== 'string') return false
    return msg.content.includes(GLOBAL_MEMORY_REMINDER_MARKER)
  })

  if (existing) {
    store.updateMessage(sessionId, existing.id, { content: reminder })
    return
  }

  const msg: UnifiedMessage = {
    id: nanoid(),
    role: 'system',
    content: reminder,
    createdAt: Date.now()
  }
  store.addMessage(sessionId, msg)
}

function App(): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme)
  const { t } = useTranslation('common')
  const shownUpdateVersionsRef = useRef(new Set<string>())
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate | null>(null)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const changelogDialogOpen = useUIStore((s) => s.changelogDialogOpen)
  const [updateDownloadPending, setUpdateDownloadPending] = useState(false)
  const [updateDownloadProgress, setUpdateDownloadProgress] = useState<number | null>(null)
  const [updateDownloadBytes, setUpdateDownloadBytes] = useState({ transferred: 0, total: 0 })
  const [downloadedUpdateVersion, setDownloadedUpdateVersion] = useState<string | null>(null)
  const [downloadedUpdateChecksum, setDownloadedUpdateChecksum] = useState<string | null>(null)
  const [installingUpdate, setInstallingUpdate] = useState(false)
  const appView = useMemo(() => getAppView(), [])
  const detachedSessionId = useMemo(() => getDetachedSessionId(), [])
  const sessionWindowView = appView === 'session' && !!detachedSessionId
  const sshWindowView = useMemo(() => isSshWindowView(), [])
  const rendererOomRecoveryRef = useRef(consumeRendererOomRecoveryFlag())
  const cronLogBufferRef = useRef<CronAgentLogEntry[]>([])
  const cronLogFlushTimerRef = useRef<number | null>(null)
  const onboardingCompleted = useSettingsStore((s) => s.onboardingCompleted)
  const videoGenerationEnabled = useSettingsStore((s) => s.videoGenerationEnabled)
  const [settingsHydrated, setSettingsHydrated] = useState(() =>
    useSettingsStore.persist.hasHydrated()
  )
  const [settingsHydrationError, setSettingsHydrationError] = useState<string | null>(null)

  useEffect(() => {
    void useRemoteAccountStore.getState().hydrate()
  }, [])

  useEffect(() => {
    const register = (workspaceId: string, refresh = false, reloadSessions = false): void => {
      if (refresh) invalidateWindowWorkspaceRegistration()
      void ensureWindowWorkspaceRegistered(workspaceId)
        .then(async () => {
          if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return
          if (reloadSessions) await useChatStore.getState().loadFromDb()
          if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return
          await ipcClient.invoke('media:settings-update', {
            videoGenerationEnabled: useSettingsStore.getState().videoGenerationEnabled
          })
          if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return
          void useCronStore.getState().loadJobs()
          void useCronStore.getState().loadRuns()
        })
        .catch((error) => {
          console.warn('[App] Failed to register window workspace', error)
        })
    }
    register(useWorkspaceStore.getState().activeWorkspaceId)
    return useWorkspaceStore.subscribe((state, previous) => {
      if (state.activeWorkspaceId !== previous.activeWorkspaceId) {
        useCronStore.getState().clearWorkspace()
        cronLogBufferRef.current = []
        if (cronLogFlushTimerRef.current !== null) {
          window.clearTimeout(cronLogFlushTimerRef.current)
          cronLogFlushTimerRef.current = null
        }
      }
      if (
        state.activeWorkspaceId !== previous.activeWorkspaceId ||
        state.olaWorkspaces !== previous.olaWorkspaces
      )
        register(
          state.activeWorkspaceId,
          state.activeWorkspaceId === previous.activeWorkspaceId,
          state.activeWorkspaceId !== previous.activeWorkspaceId
        )
    })
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const state = useRemoteAccountStore.getState()
      if (state.account && state.device) {
        void state.heartbeatDevice().catch(() => undefined)
        void state.syncWorkspaces().catch(() => undefined)
      }
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    void reattachActiveTsRuntimeRuns(useWorkspaceStore.getState().activeWorkspaceId).catch(
      (error) => {
        console.warn(
          '[App] Failed to recover active TS runtime runs',
          error instanceof Error ? error.message : String(error)
        )
      }
    )
  }, [])

  useEffect(() => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId
    void ensureWindowWorkspaceRegistered(workspaceId)
      .then(() => {
        if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return
        return ipcClient.invoke('media:settings-update', { videoGenerationEnabled })
      })
      .catch((error) =>
        console.warn(
          '[App] Failed to update media capability state',
          error instanceof Error ? error.message : String(error)
        )
      )
  }, [videoGenerationEnabled])

  // Initialize plugin auto-reply agent loop listener only in the main app window.
  usePluginAutoReply(!sessionWindowView && !sshWindowView)

  useEffect(() => {
    if (useSettingsStore.persist.hasHydrated()) {
      setSettingsHydrated(true)
      return
    }

    let settled = false
    const timeout = window.setTimeout(() => {
      if (settled) return
      setSettingsHydrationError(
        t('app.errors.settingsHydrationTimeout', {
          defaultValue: 'Settings could not be loaded from the desktop process.'
        })
      )
    }, 12_000)
    const unsubscribe = useSettingsStore.persist.onFinishHydration(() => {
      settled = true
      window.clearTimeout(timeout)
      setSettingsHydrationError(null)
      setSettingsHydrated(true)
    })
    return () => {
      settled = true
      window.clearTimeout(timeout)
      unsubscribe()
    }
  }, [t])

  // Load sessions and plans from SQLite on startup
  useEffect(() => {
    void (async () => {
      // The window always opens on the default home view (a fresh new-session
      // compose screen) rather than restoring the previously opened route.
      const initialWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId
      await ensureWindowWorkspaceRegistered(initialWorkspaceId)
      if (useWorkspaceStore.getState().activeWorkspaceId === initialWorkspaceId)
        await useChatStore.getState().loadFromDb()
      // Plans/goals full-table loads only feed downstream panels, not the
      // homepage first paint — load them concurrently off the critical path.
      void Promise.all([
        usePlanStore.getState().loadPlansFromDb(),
        useGoalStore.getState().loadGoalsFromDb()
      ])
      if (sessionWindowView && detachedSessionId) {
        const hasDetachedSession = useChatStore
          .getState()
          .sessions.some((session) => session.id === detachedSessionId)
        if (hasDetachedSession) {
          useChatStore.getState().setActiveSession(detachedSessionId)
          useUIStore.getState().navigateToSession(detachedSessionId)
        }
      } else {
        useUIStore.getState().applyRouteFromLocation()
      }

      const activeSessionId = useChatStore.getState().activeSessionId
      const activePlan = activeSessionId
        ? await usePlanStore.getState().loadPlanForSession(activeSessionId)
        : undefined
      usePlanStore.getState().setActivePlan(activePlan?.id ?? null)

      if (rendererOomRecoveryRef.current) {
        const recoverySessionId = useChatStore.getState().activeSessionId
        useSettingsStore.getState().updateSettings({ animationsEnabled: false })
        useUIStore.setState({
          detailPanelOpen: false,
          detailPanelContent: null,
          previewPanelOpen: false,
          previewPanelState: null,
          previewPanelTabs: [],
          activePreviewPanelTabId: null,
          orchestrationConsoleOpen: false,
          selectedOrchestrationRunId: null,
          selectedOrchestrationMemberId: null,
          subAgentExecutionDetailOpen: false,
          subAgentExecutionDetailToolUseId: null,
          subAgentExecutionDetailInlineText: null,
          selectedSubAgentToolUseId: null,
          rightPanelOpen: false
        })
        await useChatStore.getState().recoverFromRendererOom(recoverySessionId)
        toast.warning('Renderer recovered in reduced-memory mode')
      }
    })()
    ipcClient
      .invoke('settings:get', 'apiKey')
      .then((key) => {
        if (typeof key === 'string' && key) {
          useSettingsStore.getState().updateSettings({ apiKey: key })
        }
      })
      .catch(() => {
        // Ignore — main process may not have a stored key yet
      })
  }, [detachedSessionId, sessionWindowView])

  useEffect(() => {
    if (sessionWindowView) return

    const syncFromLocation = (): void => {
      useUIStore.getState().applyRouteFromLocation()
    }

    window.addEventListener('hashchange', syncFromLocation)
    return () => window.removeEventListener('hashchange', syncFromLocation)
  }, [sessionWindowView])

  useEffect(() => installSessionRuntimeSyncListener(), [])
  useEffect(() => installRendererMemoryMonitor(), [])
  useEffect(() => installGoalSyncListener(), [])

  useEffect(
    () =>
      installAgentRuntimeSyncListener((event: AgentRuntimeSyncEvent) => {
        withAgentRuntimeSyncSuppressed(() => {
          const store = useAgentStore.getState()
          switch (event.kind) {
            case 'set_running':
              store.setRunning(event.running)
              return
            case 'set_session_status':
              store.setSessionStatus(event.sessionId, event.status)
              return
            case 'add_tool_call':
              store.addToolCall(event.toolCall, event.sessionId)
              return
            case 'update_tool_call':
              store.updateToolCall(event.id, event.patch, event.sessionId)
              return
            case 'task_add':
              useTaskStore.getState().applySyncedTaskAdd(event.task)
              useTaskBoardStore.getState().requestRefresh()
              return
            case 'task_update':
              useTaskStore.getState().applySyncedTaskUpdate(event.id, event.patch)
              useTaskBoardStore.getState().requestRefresh()
              return
            case 'task_delete':
              useTaskStore.getState().applySyncedTaskDelete(event.id)
              useTaskBoardStore.getState().requestRefresh()
              return
            case 'task_delete_session':
              useTaskStore.getState().applySyncedDeleteSessionTasks(event.sessionId)
              useTaskBoardStore.getState().requestRefresh()
              return
            case 'team_event':
              useTeamStore.getState().handleTeamEvent(event.event, event.sessionId ?? undefined)
              return
            case 'team_snapshot':
              useTeamStore
                .getState()
                .syncRuntimeSnapshot(event.snapshot, event.sessionId ?? undefined)
              return
            case 'team_meta':
              useTeamStore.getState().updateTeamMeta(event.patch)
              return
            case 'clear_session_team':
              useTeamStore.getState().clearSessionTeam(event.sessionId)
              return
            case 'subagent_event':
              store.handleSubAgentEvent(event.event, event.sessionId ?? undefined)
              return
            case 'resolve_approval':
              store.resolveApproval(event.toolCallId, event.approved)
              return
            case 'clear_pending_approvals':
              store.clearPendingApprovals()
              return
          }
        })
      }),
    []
  )

  // Navigate to the pet studio when requested from the pet window's menu.
  useEffect(() => {
    if (sessionWindowView || sshWindowView) return
    return ipcClient.on('pet:sync-event', (payload) => {
      if ((payload as { kind?: string } | null)?.kind === 'open-studio') {
        useUIStore.getState().openPetStudioPage()
      }
    })
  }, [sessionWindowView, sshWindowView])

  useEffect(() => {
    let active = true
    let refresh = Promise.resolve()
    const unsubscribe = ipcClient.on(IPC.SETTINGS_CHANGED, (payload) => {
      const key = (payload as { key?: string | null } | null)?.key
      if (key !== null && key !== 'ola-settings') return
      refresh = refresh
        .catch(() => undefined)
        .then(async () => {
          await waitForSettingsWriteIdle()
          if (active) await useSettingsStore.persist.rehydrate()
        })
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const offProjectUpdated = ipcClient.on(IPC.CHAT_PROJECT_UPDATED, (data: unknown) => {
      const payload = data as {
        workspaceId?: string
        project?: Parameters<ReturnType<typeof useChatStore.getState>['upsertProjectFromSync']>[0]
      }
      if (
        !payload?.project?.id ||
        payload.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId
      )
        return
      useChatStore.getState().upsertProjectFromSync(payload.project)
    })

    const offProjectDeleted = ipcClient.on(IPC.CHAT_PROJECT_DELETED, (data: unknown) => {
      const payload = data as { workspaceId?: string; projectId?: string }
      if (
        !payload?.projectId ||
        payload.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId
      )
        return
      useChatStore.getState().removeProjectFromSync(payload.projectId)
    })

    const offSessionUpdated = ipcClient.on(IPC.CHAT_SESSION_UPDATED, (data: unknown) => {
      const payload = data as {
        reason?: string
        session?: {
          id: string
          title: string
          icon: string | null
          mode: string
          created_at: number
          updated_at: number
          project_id?: string | null
          working_folder: string | null
          ssh_connection_id?: string | null
          pinned: number
          message_count?: number
          plugin_id?: string | null
          external_chat_id?: string | null
          provider_id?: string | null
          model_id?: string | null
        }
      }

      if (!payload?.session?.id) return
      const sessionPayload = payload.session

      const structuralReasons = new Set([
        'message-added',
        'messages-cleared',
        'messages-replaced',
        'messages-truncated',
        'session-created-with-message'
      ])
      const reason = payload.reason ?? ''
      const chatState = useChatStore.getState()
      const existingSession = chatState.sessions.find((session) => session.id === sessionPayload.id)
      const payloadMessageCount =
        sessionPayload.message_count ??
        existingSession?.messageCount ??
        existingSession?.messages.length ??
        0
      const localMessageCount =
        existingSession?.messageCount ?? existingSession?.messages.length ?? 0
      const hasResidentMessages = Boolean(
        existingSession &&
        (existingSession.messages.length > 0 ||
          (existingSession.messagesLoaded && existingSession.messageCount > 0))
      )
      const isAppendReason = reason === 'message-added' || reason === 'session-created-with-message'
      const isReplaceReason = reason === 'messages-replaced' || reason === 'messages-truncated'
      const shouldReloadMessages =
        structuralReasons.has(reason) &&
        hasResidentMessages &&
        (isReplaceReason || (isAppendReason && localMessageCount !== payloadMessageCount))

      chatState.upsertSessionFromSync(sessionPayload, {
        preserveLoadedMessages: hasResidentMessages || shouldReloadMessages
      })

      if (shouldReloadMessages) {
        void chatState
          .loadRecentSessionMessages(sessionPayload.id, true)
          .finally(() => useChatStore.getState().scheduleSessionMaintenance())
      }
    })

    const offSessionDeleted = ipcClient.on(IPC.CHAT_SESSION_DELETED, (data: unknown) => {
      const payload = data as { sessionId?: string }
      if (!payload?.sessionId) return
      useChatStore.getState().removeSessionFromSync(payload.sessionId)
    })

    return () => {
      offProjectUpdated()
      offProjectDeleted()
      offSessionUpdated()
      offSessionDeleted()
    }
  }, [])

  // Watch global memory file and refresh system context on changes
  useEffect(() => {
    let disposed = false
    let ready = false
    let baselineVersion = 0

    const init = async (): Promise<void> => {
      await loadGlobalMemorySnapshot(ipcClient, useWorkspaceStore.getState().activeWorkspaceId)
      const snapshot = getGlobalMemorySnapshot()
      baselineVersion = snapshot.version
      ready = true
    }

    void init()

    const unsubscribe = subscribeGlobalMemoryUpdates((snapshot) => {
      if (disposed || !ready) return
      if (snapshot.version <= baselineVersion) return

      const sessionId = useChatStore.getState().activeSessionId
      if (!sessionId) return

      const lastVersion = globalMemoryVersionBySession.get(sessionId) ?? 0
      if (snapshot.version <= lastVersion) return

      globalMemoryVersionBySession.set(sessionId, snapshot.version)
      upsertGlobalMemoryReminder(sessionId, snapshot)
    })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  // Forward cron:fired IPC events to the renderer-side event bus
  useEffect(() => {
    const offFired = ipcClient.on('cron:fired', (data: unknown) => {
      if (!isCronWorkspaceEventFor(data, useWorkspaceStore.getState().activeWorkspaceId)) return
      const d = data as {
        jobId: string
        sessionId?: string | null
        name?: string
        prompt?: string
        agentId?: string | null
        model?: string | null
        workingFolder?: string | null
        sshConnectionId?: string | null
        firedAt?: number
        deliveryMode?: string
        deliveryTarget?: string | null
        maxIterations?: number
        pluginId?: string | null
        pluginChatId?: string | null
        error?: string
      }
      cronEvents.emit({ type: 'fired', ...d })
      useCronStore.getState().updateJob(d.jobId, { lastFiredAt: Date.now() })
    })

    const offRemoved = ipcClient.on('cron:job-removed', (data: unknown) => {
      if (!isCronWorkspaceEventFor(data, useWorkspaceStore.getState().activeWorkspaceId)) return
      const d = data as { jobId: string; reason: string }
      cronEvents.emit({
        type: 'job_removed',
        jobId: d.jobId,
        reason: d.reason as 'delete_after_run' | 'manual'
      })
      useCronStore.getState().removeJob(d.jobId)
    })

    const offRunStarted = ipcClient.on('cron:run-started', (data: unknown) => {
      if (!isCronWorkspaceEventFor(data, useWorkspaceStore.getState().activeWorkspaceId)) return
      const d = data as { jobId: string; runId: string }
      useCronStore.getState().setExecutionStarted(d.jobId)
    })

    const offRunProgress = ipcClient.on('cron:run-progress', (data: unknown) => {
      if (!isCronWorkspaceEventFor(data, useWorkspaceStore.getState().activeWorkspaceId)) return
      const d = data as {
        jobId: string
        runId: string
        iteration: number
        toolCalls: number
        elapsed: number
        currentStep?: string
      }
      useCronStore.getState().updateExecutionProgress(d.jobId, {
        iteration: d.iteration,
        toolCalls: d.toolCalls,
        currentStep: d.currentStep
      })
    })

    const flushCronLogBuffer = (): void => {
      if (cronLogFlushTimerRef.current !== null) {
        window.clearTimeout(cronLogFlushTimerRef.current)
        cronLogFlushTimerRef.current = null
      }

      const entries = cronLogBufferRef.current
      if (entries.length === 0) return
      cronLogBufferRef.current = []
      useCronStore.getState().appendAgentLogs(entries)
    }

    const scheduleCronLogFlush = (): void => {
      if (cronLogFlushTimerRef.current !== null) return
      cronLogFlushTimerRef.current = window.setTimeout(() => {
        flushCronLogBuffer()
      }, 100)
    }

    const offRunLog = ipcClient.on('cron:run-log-appended', (data: unknown) => {
      if (!isCronWorkspaceEventFor(data, useWorkspaceStore.getState().activeWorkspaceId)) return
      const d = data as {
        jobId: string
        timestamp: number
        type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end'
        content: string
      }
      cronLogBufferRef.current.push(d)
      scheduleCronLogFlush()
    })

    const offRunFinishedIpc = ipcClient.on('cron:run-finished', (data: unknown) => {
      if (!isCronWorkspaceEventFor(data, useWorkspaceStore.getState().activeWorkspaceId)) return
      flushCronLogBuffer()
      const d = data as {
        jobId: string
        runId: string
        status: 'success' | 'error' | 'aborted' | 'skipped'
        toolCallCount: number
        jobName?: string
        sessionId?: string | null
        deliveryMode?: string
        deliveryTarget?: string | null
        outputSummary?: string
        error?: string
        run?: import('./stores/cron-store').CronRunEntry
        job?: import('./stores/cron-store').CronJobEntry | null
      }
      const cronStore = useCronStore.getState()
      cronStore.clearExecutionState(d.jobId)
      if (d.job) {
        cronStore.upsertJob(d.job)
      }
      if (d.run) {
        cronStore.recordRun(d.run)
      }
      cronEvents.emit({ type: 'run_finished', ...d })
    })

    // notify:session-message — inject a message into a session from the Notify tool
    const offNotify = sessionWindowView
      ? () => {}
      : ipcClient.on('notify:session-message', (data: unknown) => {
          const d = data as { sessionId: string; title: string; body: string }
          const sessions = useChatStore.getState().sessions
          if (!sessions.some((s) => s.id === d.sessionId)) return
          const msg: UnifiedMessage = {
            id: nanoid(),
            role: 'assistant',
            content: `<system-reminder>\n**${d.title}**\n</system-reminder>\n\n${d.body}`,
            createdAt: Date.now()
          }
          useChatStore.getState().addMessage(d.sessionId, msg)
        })

    // Main persists the delivery once; every visible window may refresh its read model.
    const offSessionDelivered = ipcClient.on(IPC.CRON_SESSION_DELIVERED, (data: unknown) => {
      if (!isCronWorkspaceEventFor(data, useWorkspaceStore.getState().activeWorkspaceId)) return
      const sessionId = (data as { sessionId?: string }).sessionId
      if (!sessionId) return
      if (!useChatStore.getState().sessions.some((session) => session.id === sessionId)) return
      void useChatStore.getState().loadSessionMessages(sessionId, true)
    })

    return () => {
      offFired()
      offRemoved()
      offRunStarted()
      offRunProgress()
      offRunLog()
      offRunFinishedIpc()
      offNotify()
      offSessionDelivered()
      flushCronLogBuffer()
    }
  }, [sessionWindowView, t])

  // Reload SSH config when local JSON changes
  useEffect(() => {
    const offSshConfigChanged = ipcClient.on('ssh:config:changed', () => {
      void useSshStore.getState().loadAll()
    })

    return () => {
      offSshConfigChanged()
    }
  }, [])

  // Listen for app update notifications from main process
  useEffect(() => {
    const offUpdateAvailable = ipcClient.on('update:available', (data: unknown) => {
      const d = data as { currentVersion: string; newVersion: string; releaseNotes: string }
      const currentVersion = normalizeVersion(d.currentVersion)
      const newVersion = normalizeVersion(d.newVersion)

      if (compareVersions(newVersion, currentVersion) <= 0) {
        console.log(
          `[App] Ignore non-newer update event: current=${currentVersion}, latest=${newVersion}`
        )
        return
      }

      if (shownUpdateVersionsRef.current.has(newVersion)) {
        console.log(`[App] Ignore duplicate update notification for version ${newVersion}`)
        return
      }

      shownUpdateVersionsRef.current.add(newVersion)
      setAvailableUpdate({
        currentVersion,
        newVersion,
        releaseNotes: d.releaseNotes || ''
      })
      setDownloadedUpdateVersion(null)
      setInstallingUpdate(false)
      setUpdateDownloadPending(false)
      setUpdateDownloadProgress(null)
      setUpdateDownloadBytes({ transferred: 0, total: 0 })
      setDownloadedUpdateChecksum(null)
    })

    const offUpdateProgress = ipcClient.on('update:download-progress', (data: unknown) => {
      const d = data as { percent: number; transferred?: number; total?: number }
      setDownloadedUpdateVersion(null)
      setUpdateDownloadPending(true)
      setUpdateDownloadProgress(typeof d.percent === 'number' ? d.percent : null)
      setUpdateDownloadBytes({ transferred: d.transferred ?? 0, total: d.total ?? 0 })
    })

    const offUpdateDownloaded = ipcClient.on('update:downloaded', (data: unknown) => {
      const d = data as { version: string; checksum?: string; checksumVerified?: boolean }
      const version = normalizeVersion(d.version) || d.version
      setUpdateDownloadPending(false)
      setUpdateDownloadProgress(null)
      setInstallingUpdate(false)
      setDownloadedUpdateVersion(version)
      setDownloadedUpdateChecksum(d.checksumVerified ? (d.checksum ?? null) : null)
      setUpdateDialogOpen(true)
      toast.success(t('app.update.downloadedTitle'), {
        description: t('app.update.downloadedDescription', { version })
      })
    })

    const offUpdateError = ipcClient.on('update:error', (data: unknown) => {
      const d = data as { error: string }
      setUpdateDownloadPending(false)
      setUpdateDownloadProgress(null)
      setInstallingUpdate(false)
      toast.error(t('app.update.failed'), { description: d.error })
    })

    void (async () => {
      const result = (await ipcClient.invoke(IPC.UPDATE_STATUS)) as
        | {
            success: true
            downloadedVersion: string | null
            checksum: string | null
            checksumVerified: boolean
          }
        | { success: false; error: string }

      if (!result.success || !result.downloadedVersion) return

      const version = normalizeVersion(result.downloadedVersion) || result.downloadedVersion
      setDownloadedUpdateVersion(version)
      setDownloadedUpdateChecksum(result.checksumVerified ? result.checksum : null)
    })()

    return () => {
      offUpdateAvailable()
      offUpdateProgress()
      offUpdateDownloaded()
      offUpdateError()
    }
  }, [t])

  const handleUpdateNow = async (): Promise<void> => {
    if (!availableUpdate || updateDownloadPending) {
      return
    }

    setUpdateDownloadPending(true)
    setUpdateDownloadProgress(null)
    toast.info(t('app.update.downloading'))

    const result = (await ipcClient.invoke('update:download')) as
      | { success: true }
      | { success: false; error: string }

    if (!result.success) {
      setUpdateDownloadPending(false)
      toast.error(t('app.update.downloadFailed'), { description: result.error })
    }
  }

  const handleInstallDownloadedUpdate = async (): Promise<void> => {
    if (!downloadedUpdateVersion || installingUpdate) {
      return
    }

    setInstallingUpdate(true)
    const result = (await ipcClient.invoke(IPC.UPDATE_INSTALL)) as
      | { success: true }
      | { success: false; error: string }

    if (!result.success) {
      setInstallingUpdate(false)
      toast.error(t('app.update.installFailed'), { description: result.error })
    }
  }

  // Sync i18n language with settings store
  const language = useSettingsStore((s) => s.language)
  useEffect(() => {
    if (i18n.language !== language) {
      i18n.changeLanguage(language)
    }
  }, [language])

  // Update web search tool registration based on settings
  const webSearchEnabled = useSettingsStore((s) => s.webSearchEnabled)
  useEffect(() => {
    updateWebSearchToolRegistration(webSearchEnabled)
  }, [webSearchEnabled])

  const advancedDrawEnabled = useSettingsStore((s) => s.advancedDrawEnabled)
  useEffect(() => {
    updateCanvasToolRegistration(advancedDrawEnabled)
  }, [advancedDrawEnabled])

  useEffect(() => {
    updateVideoGenerationToolRegistration(videoGenerationEnabled)
  }, [videoGenerationEnabled])

  useEffect(() => {
    updateAppPluginToolRegistration()

    const unsubscribePlugin = useAppPluginStore.subscribe(() => {
      updateAppPluginToolRegistration()
    })
    const unsubscribeProvider = useProviderStore.subscribe(() => {
      updateAppPluginToolRegistration()
    })
    const unsubscribeChat = useChatStore.subscribe((state, previousState) => {
      if (state.activeProjectId !== previousState.activeProjectId) {
        updateAppPluginToolRegistration()
      }
    })

    return () => {
      unsubscribePlugin()
      unsubscribeProvider()
      unsubscribeChat()
    }
  }, [])

  useEffect(() => {
    void refreshExtensionTools()
  }, [])

  useEffect(() => {
    const unsubscribeChat = useChatStore.subscribe((state, previousState) => {
      if (state.activeProjectId !== previousState.activeProjectId) {
        void refreshExtensionTools()
        void refreshExtensionWorkbenchContributions()
      }
    })

    return () => {
      unsubscribeChat()
    }
  }, [])

  // Global unhandled promise rejection handler
  useEffect(() => {
    const handler = (e: PromiseRejectionEvent): void => {
      console.error('[Unhandled Rejection]', e.reason)
      toast.error(t('app.errors.unhandledTitle'), {
        description: e.reason?.message || String(e.reason)
      })
    }
    window.addEventListener('unhandledrejection', handler)
    return () => window.removeEventListener('unhandledrejection', handler)
  }, [t])

  if (sshWindowView) {
    return (
      <ErrorBoundary>
        <ThemeProvider defaultTheme={theme}>
          <ThemeRuntimeSync />
          <RemotePage standalone />
          <Toaster position="bottom-left" theme="system" richColors />
          <ConfirmDialogProvider />
          <NotifyToastContainer />
        </ThemeProvider>
      </ErrorBoundary>
    )
  }

  if (sessionWindowView && detachedSessionId) {
    return (
      <ErrorBoundary>
        <ThemeProvider defaultTheme={theme}>
          <ThemeRuntimeSync />
          <DetachedSessionPage sessionId={detachedSessionId} />
          <Toaster position="bottom-left" theme="system" richColors />
          <ConfirmDialogProvider />
          <NotifyToastContainer />
        </ThemeProvider>
      </ErrorBoundary>
    )
  }

  if (!settingsHydrated) {
    return (
      <ErrorBoundary>
        <ThemeProvider defaultTheme={theme}>
          <ThemeRuntimeSync />
          <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
            <div className="flex max-w-md flex-col items-center gap-4 text-center">
              {settingsHydrationError ? (
                <>
                  <div>
                    <h1 className="text-sm font-medium">
                      {t('app.errors.settingsHydrationTitle', {
                        defaultValue: 'Ola is taking too long to start'
                      })}
                    </h1>
                    <p className="mt-2 text-sm text-muted-foreground">{settingsHydrationError}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSettingsHydrationError(null)
                        void Promise.resolve(useSettingsStore.persist.rehydrate()).catch(
                          (error) => {
                            setSettingsHydrationError(
                              error instanceof Error ? error.message : String(error)
                            )
                          }
                        )
                      }}
                    >
                      {t('app.errors.settingsHydrationRetry', { defaultValue: 'Retry' })}
                    </Button>
                    <Button onClick={() => window.location.reload()}>
                      {t('app.errors.settingsHydrationReload', { defaultValue: 'Reload window' })}
                    </Button>
                  </div>
                </>
              ) : (
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              )}
            </div>
          </div>
        </ThemeProvider>
      </ErrorBoundary>
    )
  }

  if (!onboardingCompleted) {
    return (
      <ErrorBoundary>
        <ThemeProvider defaultTheme={theme}>
          <ThemeRuntimeSync />
          <OnboardingPage />
          <Toaster position="bottom-left" theme="system" richColors />
        </ThemeProvider>
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme={theme}>
        <ThemeRuntimeSync />
        <Layout
          updateInfo={
            availableUpdate || downloadedUpdateVersion
              ? {
                  newVersion: downloadedUpdateVersion ?? availableUpdate?.newVersion ?? '',
                  downloading: updateDownloadPending,
                  downloadProgress: updateDownloadProgress,
                  downloaded: !!downloadedUpdateVersion
                }
              : null
          }
          onOpenUpdateDialog={() => setUpdateDialogOpen(true)}
        />

        <Dialog
          open={!!(availableUpdate || downloadedUpdateVersion) && updateDialogOpen}
          onOpenChange={setUpdateDialogOpen}
        >
          <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl">
            <DialogHeader className="border-b px-6 py-5 pr-12">
              <DialogTitle>
                {downloadedUpdateVersion
                  ? t('app.update.readyTitle', { version: downloadedUpdateVersion })
                  : t('app.update.availableTitle', { version: availableUpdate?.newVersion ?? '' })}
              </DialogTitle>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>
                  {t('app.update.currentVersion', {
                    version: availableUpdate?.currentVersion ?? '-'
                  })}
                </span>
                <span>→</span>
                <span>
                  {t('app.update.latestVersion', {
                    version: downloadedUpdateVersion ?? availableUpdate?.newVersion ?? '-'
                  })}
                </span>
              </div>
            </DialogHeader>

            <div className="max-h-[min(60vh,36rem)] overflow-y-auto px-6 py-4">
              <div className="mb-3 text-xs font-medium text-muted-foreground">
                {t('app.update.releaseNotes')}
              </div>
              {availableUpdate?.releaseNotes ? (
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown
                    remarkPlugins={MARKDOWN_REMARK_PLUGINS}
                    rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                    components={createMarkdownComponents()}
                  >
                    {availableUpdate.releaseNotes}
                  </ReactMarkdown>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('app.update.noReleaseNotes')}</p>
              )}
              {downloadedUpdateChecksum && (
                <div className="mt-4 rounded-md border bg-muted/40 px-3 py-2 text-xs">
                  <div className="font-medium text-foreground">
                    {t('app.update.checksumVerified')}
                  </div>
                  <div className="mt-1 break-all font-mono text-muted-foreground">
                    SHA-512 {downloadedUpdateChecksum}
                  </div>
                </div>
              )}
            </div>

            <DialogFooter className="border-t px-6 py-4 sm:justify-between">
              <div className="text-xs text-muted-foreground">
                {updateDownloadPending
                  ? typeof updateDownloadProgress === 'number'
                    ? t('app.update.downloadingProgress', {
                        progress: Math.round(updateDownloadProgress),
                        transferred: (updateDownloadBytes.transferred / 1024 / 1024).toFixed(1),
                        total: (updateDownloadBytes.total / 1024 / 1024).toFixed(1)
                      })
                    : t('app.update.downloading')
                  : downloadedUpdateVersion
                    ? t('app.update.readyDescription')
                    : t('app.update.availableDescription')}
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button
                  variant="outline"
                  onClick={() => {
                    if (downloadedUpdateVersion) {
                      toast.info(t('app.update.delayed'))
                    }
                    setUpdateDialogOpen(false)
                  }}
                  disabled={installingUpdate}
                >
                  {downloadedUpdateVersion
                    ? t('app.update.actions.updateLater')
                    : t('app.update.actions.remindLater')}
                </Button>
                <Button
                  onClick={() =>
                    downloadedUpdateVersion
                      ? void handleInstallDownloadedUpdate()
                      : void handleUpdateNow()
                  }
                  disabled={updateDownloadPending || installingUpdate}
                >
                  {(updateDownloadPending || installingUpdate) && (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  )}
                  {downloadedUpdateVersion
                    ? installingUpdate
                      ? t('app.update.installing')
                      : t('app.update.actions.restartAndInstall')
                    : updateDownloadPending
                      ? typeof updateDownloadProgress === 'number'
                        ? t('app.update.downloadingProgress', {
                            progress: Math.round(updateDownloadProgress),
                            transferred: (updateDownloadBytes.transferred / 1024 / 1024).toFixed(1),
                            total: (updateDownloadBytes.total / 1024 / 1024).toFixed(1)
                          })
                        : t('app.update.downloading')
                      : t('app.update.actions.updateNow')}
                </Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <ChangelogDialog
          open={changelogDialogOpen}
          onOpenChange={(open) => useUIStore.getState().setChangelogDialogOpen(open)}
        />

        <Toaster position="bottom-left" theme="system" richColors />
        <ConfirmDialogProvider />
        <NotifyToastContainer />
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
