import { useCallback, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect } from 'react'
import {
  Check,
  ClipboardCopy,
  Eraser,
  ExternalLink,
  ImageDown,
  FileOutput,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Minimize2,
  Pencil,
  Trash2
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@renderer/components/ui/button'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { MessageList } from '@renderer/components/chat/MessageList'
import { ContextCompressionPreviewDialog } from '@renderer/components/chat/ContextCompressionPreviewDialog'
import { ImageEditDialog } from '@renderer/components/chat/ImageEditDialog'
import { InputArea } from '@renderer/components/chat/InputArea'
import { ProjectTerminalDock } from '@renderer/components/terminal/ProjectTerminalDock'
import { WorkingFolderSelectorDialog } from '@renderer/components/chat/WorkingFolderSelectorDialog'
import { getProjectTerminalDockLayout } from '@renderer/lib/workbench/project-terminal-dock-layout'
import { RuntimeStatusPanel } from './RuntimeStatusPanel'
import {
  abortSession,
  clearPendingSessionMessages,
  type ContextCompressionPreview,
  useChatActions
} from '@renderer/hooks/use-chat-actions'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { openDetachedSessionWindow } from '@renderer/lib/session-window'
import {
  exportSessionMarkdownFromDb,
  exportSessionResultReportFromDb
} from '@renderer/lib/utils/export-chat'
import { copySessionAsImageToClipboard } from '@renderer/lib/utils/export-session-image'
import { cn } from '@renderer/lib/utils'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { toast } from 'sonner'

interface SessionConversationPaneProps {
  sessionId?: string | null
  allowOpenInNewWindow?: boolean
  windowHeaderOwnsTitle?: boolean
}

const TERMINAL_DOCK_TRANSITION = {
  duration: 0.24,
  ease: [0.22, 1, 0.36, 1] as const
}

export function SessionConversationPane({
  sessionId,
  allowOpenInNewWindow = true,
  windowHeaderOwnsTitle = false
}: SessionConversationPaneProps): React.JSX.Element {
  const { t } = useTranslation('layout')
  const renameSessionLabel = t('sidebar.renameSession', { defaultValue: 'Rename session' }).replace(
    /[:：]\s*$/,
    ''
  )
  const clearConversationLabel = t('layout.clearConversation', {
    defaultValue: 'Clear conversation'
  })
  const resolvedSessionId = useChatStore((state) => sessionId ?? state.activeSessionId)
  const sessionView = useChatStore(
    useShallow((state) => {
      const targetSessionId = sessionId ?? state.activeSessionId
      const currentSession = targetSessionId
        ? state.sessions.find((item) => item.id === targetSessionId)
        : undefined
      const currentProject = currentSession?.projectId
        ? state.projects.find((item) => item.id === currentSession.projectId)
        : undefined

      return {
        sessionId: targetSessionId,
        title: currentSession?.title ?? null,
        projectId: currentSession?.projectId ?? null,
        projectName: currentProject?.name ?? null,
        workingFolder: currentSession?.workingFolder ?? currentProject?.workingFolder,
        sshConnectionId: currentSession?.sshConnectionId ?? currentProject?.sshConnectionId ?? null,
        messageCount: currentSession?.messageCount ?? 0
      }
    })
  )
  const streamingMessageId = useChatStore((state) =>
    resolvedSessionId ? (state.streamingMessages[resolvedSessionId] ?? null) : null
  )
  const terminalDockOpen = useUIStore((state) =>
    sessionView.projectId
      ? Boolean(state.bottomTerminalDockOpenByProjectId[sessionView.projectId])
      : false
  )
  const preferredTerminalDockArea = useUIStore((state) =>
    sessionView.projectId
      ? (state.terminalDockAreaByProjectId[sessionView.projectId] ?? 'bottom')
      : 'bottom'
  )
  const conversationPanelFullWidth = useUIStore((state) => state.conversationPanelFullWidth)
  const setConversationPanelFullWidth = useUIStore((state) => state.setConversationPanelFullWidth)
  const animationsEnabled = useSettingsStore((state) => state.animationsEnabled)
  const isStreaming = Boolean(streamingMessageId)
  const {
    sendMessage,
    stopStreaming,
    continueLastToolExecution,
    retryLastMessage,
    editAndResend,
    deleteMessage,
    manualCompressContext,
    previewContextCompressionAt,
    applyContextCompressionPreview
  } = useChatActions()
  const updateSessionTitle = useChatStore((state) => state.updateSessionTitle)
  const clearSessionMessages = useChatStore((state) => state.clearSessionMessages)
  const deleteSession = useChatStore((state) => state.deleteSession)
  const paneRef = useRef<HTMLDivElement | null>(null)
  const [terminalLayoutWidth, setTerminalLayoutWidth] = useState(0)
  const [copiedAll, setCopiedAll] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [compressionPreviewOpen, setCompressionPreviewOpen] = useState(false)
  const [compressionPreviewLoading, setCompressionPreviewLoading] = useState(false)
  const [compressionPreviewApplying, setCompressionPreviewApplying] = useState(false)
  const [compressionPreview, setCompressionPreview] = useState<ContextCompressionPreview | null>(
    null
  )
  const compressionPreviewRequestRef = useRef(0)
  const compressionPreviewPendingRef = useRef(false)
  const compressionApplyPendingRef = useRef(false)
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')

  useEffect(() => {
    compressionPreviewRequestRef.current += 1
    compressionPreviewPendingRef.current = false
    setCompressionPreviewOpen(false)
    setCompressionPreviewLoading(false)
    setCompressionPreview(null)
  }, [resolvedSessionId])

  const handleRequestContextCompression = useCallback(
    async (messageId: string) => {
      if (compressionPreviewPendingRef.current || compressionApplyPendingRef.current) return
      compressionPreviewPendingRef.current = true
      const requestId = ++compressionPreviewRequestRef.current
      setCompressionPreviewOpen(true)
      setCompressionPreviewLoading(true)
      setCompressionPreview(null)
      try {
        const preview = await previewContextCompressionAt(messageId)
        if (requestId !== compressionPreviewRequestRef.current) return
        if (!preview || preview.sessionId !== resolvedSessionId) {
          toast.error(t('agent:contextCompression.previewFailed'))
          setCompressionPreviewOpen(false)
          return
        }
        setCompressionPreview(preview)
      } catch (error) {
        if (requestId !== compressionPreviewRequestRef.current) return
        console.error('[SessionConversationPane] Context compression preview failed', error)
        toast.error(t('agent:contextCompression.previewFailed'))
        setCompressionPreviewOpen(false)
      } finally {
        if (requestId === compressionPreviewRequestRef.current) {
          compressionPreviewPendingRef.current = false
          setCompressionPreviewLoading(false)
        }
      }
    },
    [previewContextCompressionAt, resolvedSessionId, t]
  )

  const handleApplyContextCompressionPreview = useCallback(async () => {
    if (!compressionPreview || compressionApplyPendingRef.current) return
    compressionApplyPendingRef.current = true
    const requestId = compressionPreviewRequestRef.current
    setCompressionPreviewApplying(true)
    try {
      const result = await applyContextCompressionPreview(compressionPreview)
      if (requestId !== compressionPreviewRequestRef.current) return
      if (result === 'compressed') {
        setCompressionPreviewOpen(false)
        setCompressionPreview(null)
        toast.success(t('agent:contextCompression.previewApplied'))
      } else if (result === 'blocked') {
        toast.error(t('agent:contextCompression.previewExpired'))
      } else {
        toast.error(t('agent:contextCompression.previewApplyFailed'))
      }
    } catch (error) {
      if (requestId !== compressionPreviewRequestRef.current) return
      console.error('[SessionConversationPane] Context compression apply failed', error)
      toast.error(t('agent:contextCompression.previewApplyFailed'))
    } finally {
      compressionApplyPendingRef.current = false
      setCompressionPreviewApplying(false)
    }
  }, [applyContextCompressionPreview, compressionPreview, t])

  const compactSessionHeader = sessionView.messageCount === 0
  const hasProjectFolderAction = Boolean(sessionView.projectId && sessionView.workingFolder)
  const hasTranscriptActions = sessionView.messageCount > 0
  const showSessionActionBar =
    hasProjectFolderAction || hasTranscriptActions || allowOpenInNewWindow
  const showTerminalDock = Boolean(
    sessionView.projectId &&
    terminalDockOpen &&
    (sessionView.workingFolder || sessionView.sshConnectionId)
  )
  const terminalDockLayout = getProjectTerminalDockLayout({
    workspaceWidth: terminalLayoutWidth,
    leftWidth: 0,
    terminalOpen: showTerminalDock,
    preferredArea: preferredTerminalDockArea
  })

  useEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (typeof width === 'number') setTerminalLayoutWidth(width)
    })
    observer.observe(pane)
    return () => observer.disconnect()
  }, [])

  const updateSessionProjectDirectory = useCallback(
    async (patch: Partial<{ workingFolder: string | null; sshConnectionId: string | null }>) => {
      const projectId = sessionView.projectId
      if (!projectId) return
      await useChatStore.getState().updateProjectDirectory(projectId, patch)
    },
    [sessionView.projectId]
  )

  const handleOpenWorkingFolder = useCallback(async (): Promise<void> => {
    if (!sessionView.workingFolder) return
    await ipcClient.invoke(IPC.SHELL_OPEN_PATH, sessionView.workingFolder)
  }, [sessionView.workingFolder])

  const handleCopyAll = useCallback(async (): Promise<void> => {
    if (!resolvedSessionId) return
    const session = useChatStore.getState().sessions.find((item) => item.id === resolvedSessionId)
    if (!session) return
    await navigator.clipboard.writeText(await exportSessionMarkdownFromDb(session))
    setCopiedAll(true)
    window.setTimeout(() => setCopiedAll(false), 2000)
  }, [resolvedSessionId])

  const handleCopyResultReport = useCallback(async (): Promise<void> => {
    if (!resolvedSessionId) return
    const session = useChatStore.getState().sessions.find((item) => item.id === resolvedSessionId)
    if (!session) return
    await navigator.clipboard.writeText(await exportSessionResultReportFromDb(session))
    toast.success(t('layout.resultReportCopied', { defaultValue: 'Result report copied' }))
  }, [resolvedSessionId, t])

  const handleExportImage = useCallback(async (): Promise<void> => {
    if (!resolvedSessionId) return

    setExporting(true)
    try {
      const contentNode = paneRef.current?.querySelector(
        '[data-message-content]'
      ) as HTMLElement | null
      await copySessionAsImageToClipboard({
        sessionId: resolvedSessionId,
        width: contentNode?.clientWidth
      })
      toast.success(t('layout.imageCopied', { defaultValue: 'Image copied to clipboard' }))
    } catch (error) {
      console.error('Export image failed:', error)
      toast.error(t('layout.exportImageFailed', { defaultValue: 'Export image failed' }), {
        description: String(error)
      })
    } finally {
      setExporting(false)
    }
  }, [resolvedSessionId, t])

  const handleOpenInWindow = useCallback(async (): Promise<void> => {
    if (!resolvedSessionId) return
    await openDetachedSessionWindow(resolvedSessionId)
  }, [resolvedSessionId])

  const handleTogglePanelWidth = useCallback((): void => {
    setConversationPanelFullWidth(!conversationPanelFullWidth)
  }, [conversationPanelFullWidth, setConversationPanelFullWidth])

  const handleOpenRenameDialog = useCallback((): void => {
    const nextTitle = sessionView.title?.trim()
    setRenameValue(nextTitle || '')
    setRenameDialogOpen(true)
  }, [sessionView.title])

  const handleRenameSession = useCallback((): void => {
    if (!resolvedSessionId) return
    const nextTitle = renameValue.trim()
    if (!nextTitle) return
    updateSessionTitle(resolvedSessionId, nextTitle)
    setRenameDialogOpen(false)
  }, [renameValue, resolvedSessionId, updateSessionTitle])

  const handleClearConversation = useCallback(async (): Promise<void> => {
    if (!resolvedSessionId || sessionView.messageCount === 0) return
    const confirmed = await confirm({
      title: t('layout.clearConfirm', { count: sessionView.messageCount }),
      variant: 'destructive'
    })
    if (!confirmed) return
    if (!(await clearSessionMessages(resolvedSessionId))) return
    toast.success(t('layout.conversationCleared'))
  }, [clearSessionMessages, resolvedSessionId, sessionView.messageCount, t])

  const handleDeleteSession = useCallback(async (): Promise<void> => {
    if (!resolvedSessionId) return
    const confirmed = await confirm({
      title: t('layout.deleteConfirm', {
        title: sessionView.title ?? t('sidebar.newChat', { defaultValue: 'New chat' })
      }),
      variant: 'destructive'
    })
    if (!confirmed) return
    abortSession(resolvedSessionId)
    if (await deleteSession(resolvedSessionId)) clearPendingSessionMessages(resolvedSessionId)
    else toast.error(t('sidebar_toast.deleteFailed'))
  }, [deleteSession, resolvedSessionId, sessionView.title, t])

  const conversationRoot = useMemo(() => resolvedSessionId ?? 'empty', [resolvedSessionId])
  const showInlineSessionTitle = !windowHeaderOwnsTitle

  if (!resolvedSessionId) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t('sidebar.newChat', { defaultValue: 'New chat' })}
      </div>
    )
  }

  return (
    <div
      ref={paneRef}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
    >
      <RuntimeStatusPanel sessionId={resolvedSessionId} />
      <div
        className={cn(
          'flex shrink-0 items-center gap-3 px-4 pt-3',
          showInlineSessionTitle ? (compactSessionHeader ? 'pb-1' : 'pb-2') : 'pb-2 pt-2'
        )}
      >
        <div className="min-w-0 flex-1">
          {showInlineSessionTitle ? (
            <div className="flex min-w-0 items-center gap-2">
              <div
                className={cn(
                  'min-w-0 flex-1 truncate text-foreground',
                  compactSessionHeader ? 'text-[13px] font-medium' : 'text-[14px] font-medium'
                )}
              >
                {sessionView.title ?? t('sidebar.newChat', { defaultValue: 'New chat' })}
              </div>
              {sessionView.projectId ? (
                <div className="flex min-w-0 max-w-[38%] shrink items-center gap-1.5 text-[11px] text-muted-foreground/65">
                  <span className="shrink-0 text-muted-foreground/35">/</span>
                  {sessionView.workingFolder ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="truncate cursor-default">
                          {sessionView.projectName ??
                            t('sidebar.projects', { defaultValue: 'Project' })}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{sessionView.workingFolder}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="truncate">
                      {sessionView.projectName ??
                        t('sidebar.projects', { defaultValue: 'Project' })}
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {showSessionActionBar ? (
            <div className="flex items-center rounded-lg border border-border/60 bg-background/70 p-0.5 shadow-sm backdrop-blur-sm">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 rounded-md text-muted-foreground/80 hover:text-foreground"
                    onClick={handleTogglePanelWidth}
                  >
                    {conversationPanelFullWidth ? (
                      <Minimize2 className="size-4" />
                    ) : (
                      <Maximize2 className="size-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {conversationPanelFullWidth
                    ? t('layout.useStandardWidth', { defaultValue: 'Use standard width' })
                    : t('layout.useFullWidth', { defaultValue: 'Use full width' })}
                </TooltipContent>
              </Tooltip>

              {hasProjectFolderAction || hasTranscriptActions ? (
                <div className="mx-0.5 h-4 w-px bg-border/60" />
              ) : null}

              {hasProjectFolderAction ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 rounded-md text-muted-foreground/80 hover:text-foreground"
                      onClick={() => void handleOpenWorkingFolder()}
                    >
                      <ExternalLink className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t('layout.openFolder', { defaultValue: 'Open folder' })}
                  </TooltipContent>
                </Tooltip>
              ) : null}

              {hasProjectFolderAction && hasTranscriptActions ? (
                <div className="mx-0.5 h-4 w-px bg-border/60" />
              ) : null}

              {hasTranscriptActions ? (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 rounded-md text-muted-foreground/80 hover:text-foreground"
                        onClick={handleCopyAll}
                        disabled={isStreaming}
                      >
                        {copiedAll ? (
                          <Check className="size-4 text-foreground" />
                        ) : (
                          <ClipboardCopy className="size-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t('layout.copyAll', { defaultValue: 'Copy conversation' })}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 rounded-md text-muted-foreground/80 hover:text-foreground"
                        onClick={() => void handleExportImage()}
                        disabled={exporting || isStreaming}
                      >
                        {exporting ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <ImageDown className="size-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t('layout.exportImage', { defaultValue: 'Copy as image' })}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 rounded-md text-muted-foreground/80 hover:text-foreground"
                        onClick={() => void handleClearConversation()}
                        disabled={isStreaming}
                      >
                        <Eraser className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{clearConversationLabel}</TooltipContent>
                  </Tooltip>
                </>
              ) : null}

              <div className="mx-0.5 h-4 w-px bg-border/60" />

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 rounded-md text-muted-foreground/80 hover:text-foreground"
                    aria-label={t('layout.moreActions', { defaultValue: 'Conversation actions' })}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  {hasProjectFolderAction ? (
                    <DropdownMenuItem onClick={() => void handleOpenWorkingFolder()}>
                      <ExternalLink className="size-4" />
                      {t('layout.openFolder', { defaultValue: 'Open folder' })}
                    </DropdownMenuItem>
                  ) : null}
                  {allowOpenInNewWindow ? (
                    <DropdownMenuItem onClick={() => void handleOpenInWindow()}>
                      <ExternalLink className="size-4" />
                      {t('sidebar.openInNewWindow', { defaultValue: 'Open in new window' })}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onClick={handleOpenRenameDialog}>
                    <Pencil className="size-4" />
                    {renameSessionLabel}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleTogglePanelWidth}>
                    {conversationPanelFullWidth ? (
                      <Minimize2 className="size-4" />
                    ) : (
                      <Maximize2 className="size-4" />
                    )}
                    {conversationPanelFullWidth
                      ? t('layout.useStandardWidth', { defaultValue: 'Use standard width' })
                      : t('layout.useFullWidth', { defaultValue: 'Use full width' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={handleCopyAll}
                    disabled={isStreaming || !hasTranscriptActions}
                  >
                    {copiedAll ? (
                      <Check className="size-4" />
                    ) : (
                      <ClipboardCopy className="size-4" />
                    )}
                    {t('layout.copyAll', { defaultValue: 'Copy conversation' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => void handleCopyResultReport()}
                    disabled={isStreaming || !hasTranscriptActions}
                  >
                    <FileOutput className="size-4" />
                    {t('layout.copyResultReport', { defaultValue: 'Copy result report' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => void handleExportImage()}
                    disabled={exporting || isStreaming || !hasTranscriptActions}
                  >
                    {exporting ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ImageDown className="size-4" />
                    )}
                    {t('layout.exportImage', { defaultValue: 'Copy as image' })}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => void handleClearConversation()}
                    disabled={sessionView.messageCount === 0}
                  >
                    <Eraser className="size-4" />
                    {clearConversationLabel}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => void handleDeleteSession()}
                  >
                    <Trash2 className="size-4" />
                    {t('layout.deleteConversation', { defaultValue: 'Delete conversation' })}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}
        </div>
      </div>

      <div
        data-terminal-dock-area={terminalDockLayout.effectiveArea}
        className={`flex min-h-0 flex-1 ${terminalDockLayout.effectiveArea === 'right' ? 'flex-row' : 'flex-col'}`}
      >
        <div
          key={conversationRoot}
          className={cn(
            'flex min-h-0 min-w-0 flex-1 flex-col',
            terminalDockLayout.effectiveArea === 'right' && 'min-w-[220px]'
          )}
        >
          <MessageList
            sessionId={resolvedSessionId}
            fullWidth={conversationPanelFullWidth}
            onRetry={retryLastMessage}
            onContinue={continueLastToolExecution}
            onEditUserMessage={editAndResend}
            onDeleteMessage={deleteMessage}
            onRequestContextCompression={handleRequestContextCompression}
            onCancelRequestRetry={stopStreaming}
          />
          <ContextCompressionPreviewDialog
            open={compressionPreviewOpen}
            preview={compressionPreview}
            loading={compressionPreviewLoading}
            applying={compressionPreviewApplying}
            onOpenChange={(open) => {
              if (!open && !compressionPreviewLoading && !compressionPreviewApplying) {
                compressionPreviewRequestRef.current += 1
                setCompressionPreviewOpen(false)
                setCompressionPreview(null)
              }
            }}
            onConfirm={() => void handleApplyContextCompressionPreview()}
          />
          <InputArea
            sessionId={resolvedSessionId}
            onSend={(text, images, options) =>
              sendMessage(text, images, undefined, resolvedSessionId, undefined, undefined, {
                ...options,
                clearCompletedTasksOnTurnStart: true
              })
            }
            onStop={stopStreaming}
            onSelectFolder={sessionView.projectId ? () => setFolderDialogOpen(true) : undefined}
            workingFolder={sessionView.workingFolder}
            hideWorkingFolderIndicator
            onCompressContext={manualCompressContext}
            isStreaming={isStreaming}
            fullWidth={conversationPanelFullWidth}
          />
          {terminalDockLayout.effectiveArea === 'bottom' && animationsEnabled ? (
            <AnimatePresence initial={false}>
              {showTerminalDock ? (
                <motion.div
                  key={`terminal-dock-${sessionView.projectId}`}
                  initial={{ height: 0, opacity: 0, y: 12 }}
                  animate={{ height: 'auto', opacity: 1, y: 0 }}
                  exit={{ height: 0, opacity: 0, y: 12 }}
                  transition={{
                    height: TERMINAL_DOCK_TRANSITION,
                    y: TERMINAL_DOCK_TRANSITION,
                    opacity: { duration: 0.16, ease: 'easeOut' }
                  }}
                  className="min-h-0 overflow-hidden"
                  style={{ willChange: 'height, opacity, transform' }}
                >
                  <ProjectTerminalDock
                    projectId={sessionView.projectId!}
                    projectName={sessionView.projectName}
                    workingFolder={sessionView.workingFolder ?? null}
                    sshConnectionId={sessionView.sshConnectionId}
                    dockArea="bottom"
                    canMove
                    moveDisabledReason={
                      !terminalDockLayout.canMoveRight
                        ? t('terminalDock.rightDockNeedsSpace', {
                            defaultValue: 'Expand the workspace to move the terminal to the right.'
                          })
                        : undefined
                    }
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>
          ) : terminalDockLayout.effectiveArea === 'bottom' && showTerminalDock ? (
            <ProjectTerminalDock
              projectId={sessionView.projectId!}
              projectName={sessionView.projectName}
              workingFolder={sessionView.workingFolder ?? null}
              sshConnectionId={sessionView.sshConnectionId}
              dockArea="bottom"
              canMove
              moveDisabledReason={
                !terminalDockLayout.canMoveRight
                  ? t('terminalDock.rightDockNeedsSpace', {
                      defaultValue: 'Expand the workspace to move the terminal to the right.'
                    })
                  : undefined
              }
            />
          ) : null}
        </div>
        {terminalDockLayout.effectiveArea === 'right' && showTerminalDock ? (
          <div className="min-h-0 w-[38%] min-w-[180px] max-w-[520px] shrink-0 border-l border-border/50">
            <ProjectTerminalDock
              projectId={sessionView.projectId!}
              projectName={sessionView.projectName}
              workingFolder={sessionView.workingFolder ?? null}
              sshConnectionId={sessionView.sshConnectionId}
              dockArea="right"
              canMove
            />
          </div>
        ) : null}
      </div>

      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{renameSessionLabel}</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                handleRenameSession()
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)}>
              {t('action.cancel', { ns: 'common' })}
            </Button>
            <Button onClick={handleRenameSession} disabled={!renameValue.trim()}>
              {t('action.save', { ns: 'common' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {sessionView.projectId ? (
        <WorkingFolderSelectorDialog
          open={folderDialogOpen}
          onOpenChange={setFolderDialogOpen}
          workingFolder={sessionView.workingFolder}
          sshConnectionId={sessionView.sshConnectionId}
          onSelectLocalFolder={(folderPath) =>
            updateSessionProjectDirectory({
              workingFolder: folderPath,
              sshConnectionId: null
            })
          }
          onSelectSshFolder={(folderPath, connectionId) =>
            updateSessionProjectDirectory({
              workingFolder: folderPath,
              sshConnectionId: connectionId
            })
          }
        />
      ) : null}
      <ImageEditDialog sessionId={resolvedSessionId} />
    </div>
  )
}
