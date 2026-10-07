import * as React from 'react'
import { AlertCircle, ArrowLeft, Clock3, Copy, Eye, Loader2, RefreshCw, Square } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import {
  executionRecordFromTsRun,
  executionRecordFromCronRun,
  needsExecutionAttention,
  type ExecutionRecord
} from '../../../../shared/execution-record'
import type { ExecutionArtifact } from '../../../../shared/execution-artifact'
import type { RunSnapshot } from '../../../../shared/runtime/contracts'
import type { UnifiedMessage } from '@renderer/lib/api/types'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import {
  listExecutionRecords,
  type ExecutionRecordCursor
} from '@renderer/lib/ipc/execution-record-bridge'
import { listExecutionArtifacts } from '@renderer/lib/ipc/execution-artifact-bridge'
import { cancelTsRuntimeRun, getTsRuntimeRunSnapshot } from '@renderer/lib/ipc/ts-runtime-bridge'
import { useChatStore } from '@renderer/stores/chat-store'
import { createExecutionRetryDraft } from '@renderer/lib/execution-retry-draft'
import { mergeExecutionPage, refreshedExecutionCursor } from '@renderer/lib/execution-page-merge'
import { TERMINAL_STATUSES } from '../../../../shared/runtime/contracts'
import { getSessionInputDraftKey, useInputDraftStore } from '@renderer/stores/input-draft-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'
import { RunTranscriptThread } from './RunTranscriptThread'

type ExecutionCenterView = 'all' | 'attention'

interface CronRunDetail {
  messages: UnifiedMessage[]
  logs: Array<{ id: string; timestamp: number; type: string; content: string }>
  deliveries?: Array<{
    id: string
    kind: 'desktop' | 'channel' | 'session'
    status: 'pending' | 'sent' | 'failed' | 'unknown'
    startedAt: number
    finishedAt: number | null
    errorCode: string | null
    retryOfId: string | null
    attemptNumber: number
    retryAvailable: boolean
  }>
  run: {
    status?: string
    finishedAt?: number | null
    toolCallCount?: number
    deliveryStatus?: ExecutionRecord['deliveryStatus']
    outputSummary?: string | null
    error?: string | null
  }
}

function formatDuration(record: ExecutionRecord): string {
  if (!record.finishedAt) return '—'
  const seconds = Math.max(0, Math.floor((record.finishedAt - record.startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function ExecutionCenterPage({
  view,
  onViewChange,
  onOpenTask,
  onBack
}: {
  view: ExecutionCenterView
  onViewChange: (view: ExecutionCenterView) => void
  onOpenTask: (taskId: string) => void
  onBack: () => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation('layout')
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const sessions = useChatStore((state) => state.sessions)
  const projects = useChatStore((state) => state.projects)
  const [records, setRecords] = React.useState<ExecutionRecord[]>([])
  const [nextCursor, setNextCursor] = React.useState<ExecutionRecordCursor | null>(null)
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [detailError, setDetailError] = React.useState<string | null>(null)
  const [tsSnapshot, setTsSnapshot] = React.useState<RunSnapshot | null>(null)
  const [cronDetail, setCronDetail] = React.useState<CronRunDetail | null>(null)
  const [runArtifacts, setRunArtifacts] = React.useState<ExecutionArtifact[]>([])
  const [artifactNextOffset, setArtifactNextOffset] = React.useState<number | null>(null)
  const [artifactLoading, setArtifactLoading] = React.useState(false)
  const [artifactError, setArtifactError] = React.useState<string | null>(null)
  const [cancelling, setCancelling] = React.useState(false)
  const [cancelRequestedKey, setCancelRequestedKey] = React.useState<string | null>(null)
  const [reconcilingDeliveryId, setReconcilingDeliveryId] = React.useState<string | null>(null)
  const [retryingDeliveryId, setRetryingDeliveryId] = React.useState<string | null>(null)
  const [deliveryRetryDraft, setDeliveryRetryDraft] = React.useState('')
  const [expandedRetryDeliveryId, setExpandedRetryDeliveryId] = React.useState<string | null>(null)
  const listRequestId = React.useRef(0)
  const detailRequestId = React.useRef(0)
  const artifactRequestId = React.useRef(0)

  const load = React.useCallback(
    async (cursor?: ExecutionRecordCursor, background = false): Promise<void> => {
      if (workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) return
      const requestId = ++listRequestId.current
      if (!background) setLoading(true)
      try {
        const result = await listExecutionRecords(workspaceId, cursor, view)
        if (requestId !== listRequestId.current) return
        setError(null)
        setRecords((current) => {
          const incoming = result.records.filter((record) => record.workspaceId === workspaceId)
          if (!cursor && !background) return incoming
          if (background) {
            return mergeExecutionPage(current, incoming, (item) => `${item.source}:${item.id}`)
          }
          const existing = new Set(current.map((record) => `${record.source}:${record.id}`))
          return [
            ...current,
            ...incoming.filter((record) => !existing.has(`${record.source}:${record.id}`))
          ]
        })
        setNextCursor((current) => refreshedExecutionCursor(current, result.nextCursor, background))
      } catch (cause) {
        if (requestId !== listRequestId.current) return
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (requestId === listRequestId.current && !background) setLoading(false)
      }
    },
    [workspaceId, view]
  )

  React.useEffect(() => {
    const listRequest = listRequestId
    const detailRequest = detailRequestId
    setRecords([])
    setNextCursor(null)
    setSelectedKey(null)
    setTsSnapshot(null)
    setCronDetail(null)
    setCancelRequestedKey(null)
    void load()
    return () => {
      listRequest.current++
      detailRequest.current++
    }
  }, [load])

  React.useEffect(() => {
    let busy = false
    const timer = window.setInterval(() => {
      if (busy || document.visibilityState === 'hidden' || loading) return
      busy = true
      void load(undefined, true).finally(() => {
        busy = false
      })
    }, 5000)
    return () => window.clearInterval(timer)
  }, [load, loading])

  React.useEffect(() => {
    if (!cancelRequestedKey) return
    const record = records.find((item) => `${item.source}:${item.id}` === cancelRequestedKey)
    if (
      record &&
      ['completed', 'failed', 'cancelled', 'interrupted', 'skipped'].includes(record.status)
    )
      setCancelRequestedKey(null)
  }, [records, cancelRequestedKey])

  const visibleRecords = React.useMemo(
    () =>
      records
        .filter((record) => view === 'all' || needsExecutionAttention(record))
        .sort((left, right) => right.startedAt - left.startedAt),
    [records, view]
  )
  const attentionCount = React.useMemo(
    () => records.filter(needsExecutionAttention).length,
    [records]
  )

  React.useEffect(() => {
    if (!visibleRecords.some((record) => `${record.source}:${record.id}` === selectedKey)) {
      setSelectedKey(
        visibleRecords[0] ? `${visibleRecords[0].source}:${visibleRecords[0].id}` : null
      )
    }
  }, [selectedKey, visibleRecords])

  const selected = visibleRecords.find((record) => `${record.source}:${record.id}` === selectedKey)
  const selectedId = selected?.id
  const selectedSource = selected?.source

  const loadRunArtifacts = React.useCallback(
    async (offset: number, append: boolean, background = false): Promise<void> => {
      if (!selectedId || selectedSource === 'cron') return
      const requestId = ++artifactRequestId.current
      if (!background) setArtifactLoading(true)
      try {
        const page = await listExecutionArtifacts({ workspaceId, runId: selectedId, offset })
        if (requestId !== artifactRequestId.current) return
        setArtifactError(null)
        setRunArtifacts((current) =>
          background
            ? mergeExecutionPage(current, page.artifacts, (item) => item.id)
            : append
              ? [...current, ...page.artifacts]
              : page.artifacts
        )
        setArtifactNextOffset((current) =>
          refreshedExecutionCursor(current, page.nextOffset, background)
        )
      } catch (cause) {
        if (requestId === artifactRequestId.current)
          setArtifactError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (requestId === artifactRequestId.current && !background) setArtifactLoading(false)
      }
    },
    [selectedId, selectedSource, workspaceId]
  )

  React.useEffect(() => {
    const request = artifactRequestId
    request.current++
    setRunArtifacts([])
    setArtifactNextOffset(null)
    setArtifactError(null)
    if (selectedId && selectedSource !== 'cron') void loadRunArtifacts(0, false)
    return () => {
      request.current++
    }
  }, [loadRunArtifacts, selectedId, selectedSource])

  React.useEffect(() => {
    const detailRequest = detailRequestId
    const requestId = ++detailRequest.current
    setTsSnapshot(null)
    setCronDetail(null)
    setDetailError(null)
    if (!selectedId || !selectedSource) {
      setDetailLoading(false)
      return
    }
    setDetailLoading(true)
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refreshDetail = async (): Promise<void> => {
      if (stopped) return
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(() => void refreshDetail(), 3000)
        return
      }
      let keepPolling = true
      try {
        if (selectedSource === 'cron') {
          const result = await ipcClient.invoke(IPC.CRON_RUN_DETAIL, {
            runId: selectedId,
            workspaceId
          })
          if (!result || (typeof result === 'object' && 'error' in result))
            throw new Error('RUN_DETAIL_UNAVAILABLE')
          if (requestId === detailRequestId.current) setCronDetail(result as CronRunDetail)
          const detail = result as CronRunDetail
          if (requestId === detailRequestId.current && detail.run.status) {
            const projected = executionRecordFromCronRun({
              id: selectedId,
              workspaceId,
              startedAt: 0,
              status: detail.run.status,
              finishedAt: detail.run.finishedAt,
              toolCallCount: detail.run.toolCallCount,
              error: detail.run.error,
              deliveryStatus: detail.run.deliveryStatus
            })
            setRecords((current) =>
              current.map((record) =>
                record.id === selectedId && record.source === 'cron'
                  ? {
                      ...record,
                      status: projected.status,
                      finishedAt: projected.finishedAt,
                      toolCallCount: projected.toolCallCount,
                      failedToolCallCount: projected.failedToolCallCount,
                      failureReason: projected.failureReason,
                      deliveryStatus: projected.deliveryStatus
                    }
                  : record
              )
            )
          }
          keepPolling =
            detail.run.status === 'running' ||
            !detail.run.status ||
            (detail.deliveries?.some((delivery) => delivery.status === 'pending') ?? false)
        } else {
          const snapshot = await getTsRuntimeRunSnapshot({
            workspaceId,
            runId: selectedId,
            afterSeq: 0
          })
          if (requestId === detailRequestId.current) {
            setTsSnapshot(snapshot)
            if (snapshot) {
              const projected = executionRecordFromTsRun(
                snapshot.run,
                snapshot.events,
                snapshot.pendingInteractions
              )
              setRecords((current) =>
                current.map((record) =>
                  record.id === selectedId && record.source === selectedSource
                    ? {
                        ...record,
                        status: projected.status,
                        finishedAt: projected.finishedAt,
                        approvalStatus: projected.approvalStatus,
                        toolCallCount: projected.toolCallCount,
                        failedToolCallCount: projected.failedToolCallCount,
                        failureReason: projected.failureReason
                      }
                    : record
                )
              )
            }
            void loadRunArtifacts(0, false, true)
          }
          if (snapshot) keepPolling = !TERMINAL_STATUSES.has(snapshot.run.status)
        }
        if (requestId === detailRequestId.current) setDetailError(null)
      } catch (cause) {
        if (requestId === detailRequestId.current)
          setDetailError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (requestId === detailRequestId.current) setDetailLoading(false)
        if (!stopped && keepPolling) timer = setTimeout(() => void refreshDetail(), 3000)
      }
    }
    void refreshDetail()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      detailRequest.current++
    }
  }, [selectedId, selectedSource, workspaceId, loadRunArtifacts])

  const openSession = (sessionId: string): void => {
    const session = sessions.find(
      (item) => item.id === sessionId && (item.workspaceId ?? 'local-personal') === workspaceId
    )
    if (!session) return
    useChatStore.getState().setActiveSession(sessionId)
    useUIStore.getState().navigateToSession(sessionId)
  }

  const cancelRun = async (record: ExecutionRecord): Promise<void> => {
    if (cancelling || cancelRequestedKey === `${record.source}:${record.id}`) return
    setCancelling(true)
    try {
      if (record.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId)
        throw new Error(t('executionResults.workspaceChanged'))
      if (record.source === 'cron') {
        if (!record.jobId) throw new Error('RUN_JOB_UNAVAILABLE')
        const result = await ipcClient.invoke(IPC.CRON_ABORT_RUN, {
          jobId: record.jobId,
          workspaceId
        })
        if (result && typeof result === 'object' && 'error' in result)
          throw new Error(String(result.error))
      } else if (!(await cancelTsRuntimeRun({ workspaceId, runId: record.id }))) {
        throw new Error('RUN_ALREADY_STOPPED')
      }
      if (record.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) return
      setCancelRequestedKey(`${record.source}:${record.id}`)
      toast.success(t('executionCenter.cancelRequested'))
      await load()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCancelling(false)
    }
  }

  const prepareRetryDraft = async (record: ExecutionRecord): Promise<void> => {
    const originalPrompt = tsSnapshot?.run.prompt
    const sessionId = record.sessionId
    if (
      record.source !== 'chat' ||
      !sessionId ||
      typeof originalPrompt !== 'string' ||
      !originalPrompt.trim()
    )
      return
    if (
      tsSnapshot?.run.runId !== record.id ||
      record.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId
    )
      return
    const session = sessions.find(
      (item) => item.id === sessionId && (item.workspaceId ?? 'local-personal') === workspaceId
    )
    if (!session) {
      toast.error(t('executionCenter.retryDraftSessionMissing'))
      return
    }

    const drafts = useInputDraftStore.getState()
    const draftKey = getSessionInputDraftKey(sessionId)
    try {
      await drafts.hydrateDraft(draftKey)
      if (
        record.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId ||
        !useChatStore
          .getState()
          .sessions.some(
            (item) =>
              item.id === sessionId && (item.workspaceId ?? 'local-personal') === record.workspaceId
          )
      )
        throw new Error(t('executionCenter.retryDraftSessionMissing'))
      const existingDraft = drafts.getDraft(draftKey)
      const retryDraft = createExecutionRetryDraft(originalPrompt, existingDraft)
      if (!retryDraft) {
        toast.error(t('executionCenter.retryDraftPreserved'))
        return
      }
      await drafts.setDraft(draftKey, retryDraft)
      if (record.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) return
      openSession(sessionId)
      toast.success(t('executionCenter.retryDraftReady'))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t('executionCenter.retryDraftFailed'))
    }
  }

  const reconcileDelivery = async (
    deliveryId: string,
    outcome: 'sent' | 'failed'
  ): Promise<void> => {
    if (!selectedId || selectedSource !== 'cron') return
    if (reconcilingDeliveryId || retryingDeliveryId) return
    const actionRequestId = detailRequestId.current
    setReconcilingDeliveryId(deliveryId)
    try {
      const response = await ipcClient.invoke(IPC.CRON_DELIVERY_RECONCILE, {
        runId: selectedId,
        deliveryId,
        workspaceId,
        outcome
      })
      if (response && typeof response === 'object' && 'error' in response)
        throw new Error(String(response.error))
      if (
        actionRequestId !== detailRequestId.current ||
        workspaceId !== useWorkspaceStore.getState().activeWorkspaceId
      )
        return
      setCronDetail((current) =>
        current
          ? {
              ...current,
              deliveries: current.deliveries?.map((delivery) =>
                delivery.id === deliveryId
                  ? {
                      ...delivery,
                      status: outcome,
                      finishedAt: Date.now(),
                      errorCode:
                        outcome === 'sent' ? 'MANUALLY_CONFIRMED_SENT' : 'MANUALLY_CONFIRMED_FAILED'
                    }
                  : delivery
              )
            }
          : current
      )
      await load()
      toast.success(t('executionCenter.deliveryReconciled'))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setReconcilingDeliveryId(null)
    }
  }

  const retryDelivery = async (deliveryId: string): Promise<void> => {
    const runId = selectedId
    const content = deliveryRetryDraft.trim()
    if (!runId || selectedSource !== 'cron' || !content) return
    if (retryingDeliveryId || reconcilingDeliveryId) return
    const actionRequestId = detailRequestId.current
    setRetryingDeliveryId(deliveryId)
    try {
      const response = await ipcClient.invoke(IPC.CRON_DELIVERY_RETRY, {
        runId,
        deliveryId,
        workspaceId,
        content
      })
      if (!response || typeof response !== 'object') throw new Error('DELIVERY_RETRY_FAILED')
      if ('error' in response) throw new Error(String(response.error))
      if (
        actionRequestId !== detailRequestId.current ||
        workspaceId !== useWorkspaceStore.getState().activeWorkspaceId
      )
        return
      const retry = response as {
        deliveryId: string
        retryOfId: string
        status: 'sent' | 'failed' | 'unknown'
        attemptNumber: number
        startedAt: number
        finishedAt: number
        errorCode: string | null
      }
      setCronDetail((current) =>
        current
          ? {
              ...current,
              deliveries: [
                ...(current.deliveries ?? []),
                {
                  id: retry.deliveryId,
                  kind: 'channel',
                  status: retry.status,
                  startedAt: retry.startedAt,
                  finishedAt: retry.finishedAt,
                  errorCode: retry.errorCode,
                  retryOfId: retry.retryOfId,
                  attemptNumber: retry.attemptNumber,
                  retryAvailable: true
                }
              ]
            }
          : current
      )
      setExpandedRetryDeliveryId(null)
      setDeliveryRetryDraft('')
      await load()
      toast.success(
        t(
          retry.status === 'sent'
            ? 'executionCenter.deliveryRetrySent'
            : retry.status === 'failed'
              ? 'executionCenter.deliveryRetryFailed'
              : 'executionCenter.deliveryRetryUnknown'
        )
      )
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRetryingDeliveryId(null)
    }
  }

  const language = i18n.resolvedLanguage ?? i18n.language
  const dateTime = (value: number): string => new Date(value).toLocaleString(language)
  const selectedSession = selected?.sessionId
    ? sessions.find(
        (session) =>
          session.id === selected.sessionId &&
          (session.workspaceId ?? 'local-personal') === workspaceId
      )
    : undefined
  const projectName = selected?.projectId
    ? (projects.find(
        (project) =>
          project.id === selected.projectId &&
          (project.workspaceId ?? 'local-personal') === workspaceId
      )?.name ?? selected.projectId)
    : '—'

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            aria-label={t('executionCenter.back')}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <h1 className="text-base font-semibold">{t('executionCenter.title')}</h1>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant={view === 'all' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => onViewChange('all')}
          >
            {t('executionCenter.allRuns')}
          </Button>
          <Button
            variant={view === 'attention' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => onViewChange('attention')}
          >
            {t('executionCenter.loadedAttentionCount', { count: attentionCount })}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void load()}
            aria-label={t('executionCenter.refresh')}
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </header>
      <p className="border-b px-4 py-1 text-xs text-muted-foreground">
        {t('executionCenter.loadedCount', { count: records.length })}
      </p>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
        <div className="min-h-0 overflow-y-auto border-r p-3">
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('executionCenter.loading')}
            </p>
          ) : error ? (
            <div className="space-y-2 text-sm text-destructive">
              <p>{t('executionCenter.loadFailed')}</p>
              <p className="break-words text-xs">{error}</p>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                {t('executionCenter.retry')}
              </Button>
            </div>
          ) : visibleRecords.length === 0 ? (
            <div className="space-y-3 p-4">
              <p className="text-sm text-muted-foreground">
                {t(view === 'all' ? 'executionCenter.empty' : 'executionCenter.noAttention')}
              </p>
              {nextCursor && (
                <Button variant="outline" size="sm" onClick={() => void load(nextCursor)}>
                  {t('executionCenter.loadMore')}
                </Button>
              )}
            </div>
          ) : (
            <>
              {visibleRecords.map((record) => {
                const key = `${record.source}:${record.id}`
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSelectedKey(key)}
                    className={`mb-2 w-full rounded-lg border p-3 text-left text-sm hover:bg-muted/50 ${selectedKey === key ? 'border-primary/50 bg-primary/5' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="line-clamp-2 font-medium">{record.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t(`executionCenter.source.${record.source}`)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <span>{t(`executionCenter.status.${record.status}`)}</span>
                      <span>{dateTime(record.startedAt)}</span>
                      <span>{formatDuration(record)}</span>
                    </div>
                    {needsExecutionAttention(record) && (
                      <p className="mt-1 truncate text-xs text-amber-700 dark:text-amber-300">
                        {record.failureReason ??
                          (record.deliveryStatus
                            ? t(`executionCenter.deliveryStatus.${record.deliveryStatus}`)
                            : t(
                                record.approvalStatus === 'pending'
                                  ? 'executionCenter.pendingApproval'
                                  : 'executionCenter.reviewNeeded'
                              ))}
                      </p>
                    )}
                  </button>
                )
              })}
              {nextCursor && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading}
                  onClick={() => void load(nextCursor)}
                >
                  {t('executionCenter.loadMore')}
                </Button>
              )}
            </>
          )}
        </div>
        <div className="min-h-0 overflow-y-auto p-4">
          {!selected ? (
            <p className="text-sm text-muted-foreground">{t('executionCenter.selectRun')}</p>
          ) : (
            <div className="mx-auto max-w-3xl space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{selected.title}</h2>
                  <p className="break-all text-xs text-muted-foreground">{selected.id}</p>
                </div>
                <span className="rounded-full bg-muted px-2 py-1 text-xs">
                  {t(`executionCenter.status.${selected.status}`)}
                </span>
              </div>
              <dl className="grid gap-3 rounded-lg border p-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t('executionCenter.sourceLabel')}
                  </dt>
                  <dd>{t(`executionCenter.source.${selected.source}`)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('executionCenter.project')}</dt>
                  <dd className="truncate">{projectName}</dd>
                </div>
                {selected.businessTaskId && (
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      {t('executionCenter.businessTask')}
                    </dt>
                    <dd className="truncate">{selected.businessTaskId}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-xs text-muted-foreground">{t('executionCenter.started')}</dt>
                  <dd>{dateTime(selected.startedAt)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('executionCenter.duration')}</dt>
                  <dd>{formatDuration(selected)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('executionCenter.tools')}</dt>
                  <dd>{selected.toolCallCount}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('executionCenter.approval')}</dt>
                  <dd>{t(`executionCenter.approvalStatus.${selected.approvalStatus}`)}</dd>
                </div>
              </dl>
              <div className="flex flex-wrap gap-2">
                {selected.businessTaskId && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onOpenTask(selected.businessTaskId!)}
                  >
                    {t('executionCenter.openTask')}
                  </Button>
                )}
                {selectedSession && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openSession(selectedSession.id)}
                  >
                    {t('executionCenter.openSession')}
                  </Button>
                )}
                {selected.source === 'chat' &&
                  selected.sessionId &&
                  tsSnapshot?.run.prompt &&
                  ['failed', 'interrupted', 'cancelled'].includes(selected.status) && (
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="execution-center-retry-draft"
                      onClick={() => void prepareRetryDraft(selected)}
                    >
                      {t('executionCenter.prepareRetryDraft')}
                    </Button>
                  )}
                {selected.approvalStatus === 'pending' && selectedSession && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openSession(selectedSession.id)}
                  >
                    {t('executionCenter.reviewApproval')}
                  </Button>
                )}
                {(selected.status === 'running' ||
                  selected.status === 'queued' ||
                  selected.status === 'waiting_capability' ||
                  selected.status === 'cancelling' ||
                  selected.status === 'waiting_interaction') && (
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={
                      cancelling ||
                      selected.status === 'cancelling' ||
                      cancelRequestedKey === selectedKey
                    }
                    onClick={() => void cancelRun(selected)}
                  >
                    <Square className="mr-1 size-3" />
                    {t(
                      cancelRequestedKey === selectedKey
                        ? 'executionCenter.cancelRequested'
                        : 'executionCenter.cancel'
                    )}
                  </Button>
                )}
              </div>
              {selected.source === 'chat' &&
                selected.sessionId &&
                tsSnapshot?.run.prompt &&
                ['failed', 'interrupted', 'cancelled'].includes(selected.status) && (
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t('executionCenter.retryDraftWarning')}
                  </p>
                )}
              {selected.failureReason && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  <AlertCircle className="mr-2 inline size-4" />
                  {selected.failureReason}
                </div>
              )}
              {selected.fileChanges.length > 0 && (
                <section>
                  <h3 className="mb-2 text-sm font-medium">{t('executionCenter.fileChanges')}</h3>
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {selected.fileChanges.map((change) => (
                      <li key={`${change.transport}:${change.path}`} className="break-all">
                        {change.operation} · {change.path}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {selected.source === 'cron' && selected.artifacts.length > 0 && (
                <section>
                  <h3 className="mb-2 text-sm font-medium">{t('executionCenter.artifacts')}</h3>
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {selected.artifacts.map((artifact) => (
                      <li key={artifact} className="break-all">
                        {artifact}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {selected.source !== 'cron' && (
                <section>
                  <h3 className="mb-2 text-sm font-medium">
                    {t('executionCenter.confirmedArtifacts')}
                  </h3>
                  {artifactError && (
                    <p role="alert" className="text-xs text-destructive">
                      {t('executionCenter.artifactLoadFailed')}: {artifactError}
                    </p>
                  )}
                  {!artifactLoading && !artifactError && runArtifacts.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t('executionCenter.noConfirmedArtifacts')}
                    </p>
                  )}
                  <ul className="space-y-2">
                    {runArtifacts.map((artifact) => (
                      <li key={artifact.id} className="rounded-md border p-2 text-xs">
                        <p className="font-medium">{artifact.title}</p>
                        <p className="break-all text-muted-foreground">
                          {artifact.kind === 'file' ? artifact.path : artifact.url}
                        </p>
                        <p className="mt-1 text-muted-foreground">
                          {t(
                            artifact.kind === 'link'
                              ? 'executionResults.linkType'
                              : artifact.mediaType?.startsWith('image/')
                                ? 'executionResults.imageType'
                                : artifact.mediaType?.startsWith('audio/') ||
                                    artifact.mediaType?.startsWith('video/')
                                  ? 'executionResults.mediaType'
                                  : 'executionResults.fileType'
                          )}
                          {artifact.kind === 'file' && (
                            <>
                              {' · '}
                              {artifact.exists
                                ? t('executionResults.present')
                                : t('executionResults.missing')}
                            </>
                          )}
                        </p>
                        <div className="mt-2 flex gap-2">
                          {artifact.kind === 'file' && artifact.exists && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                useUIStore
                                  .getState()
                                  .openFilePreview(
                                    artifact.path,
                                    undefined,
                                    artifact.transport === 'ssh'
                                      ? artifact.connectionId
                                      : undefined,
                                    artifact.sessionId
                                  )
                              }
                            >
                              <Eye className="mr-1 size-3" />
                              {t('executionResults.preview')}
                            </Button>
                          )}
                          {artifact.kind === 'file' ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                void navigator.clipboard
                                  .writeText(artifact.path)
                                  .then(() => toast.success(t('executionResults.copied')))
                                  .catch(() => toast.error(t('executionResults.copyFailed')))
                              }
                            >
                              <Copy className="mr-1 size-3" />
                              {t('executionResults.copyPath')}
                            </Button>
                          ) : (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  void ipcClient.invoke(IPC.SHELL_OPEN_EXTERNAL, artifact.url)
                                }
                              >
                                {t('executionResults.openLink')}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void navigator.clipboard.writeText(artifact.url)}
                              >
                                {t('executionResults.copyLink')}
                              </Button>
                            </>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                  {artifactLoading && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t('executionResults.loading')}
                    </p>
                  )}
                  {!artifactLoading && artifactNextOffset !== null && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2"
                      onClick={() => void loadRunArtifacts(artifactNextOffset, true)}
                    >
                      {t('executionResults.loadMore')}
                    </Button>
                  )}
                </section>
              )}
              <section className="space-y-2 border-t pt-4">
                <h3 className="text-sm font-medium">{t('executionCenter.steps')}</h3>
                {detailLoading ? (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock3 className="size-4" />
                    {t('executionCenter.loadingDetail')}
                  </p>
                ) : detailError ? (
                  <p className="text-xs text-destructive">{detailError}</p>
                ) : selected.source === 'cron' ? (
                  <div className="space-y-3">
                    {!!cronDetail?.deliveries?.length && (
                      <section className="rounded-lg border p-3">
                        <h4 className="mb-2 text-sm font-medium">
                          {t('executionCenter.deliveryTitle')}
                        </h4>
                        <ul className="space-y-2 text-xs">
                          {cronDetail.deliveries.map((delivery) => (
                            <li key={delivery.id} className="space-y-2 rounded-md bg-muted/40 p-2">
                              <div className="flex justify-between gap-3">
                                <span>
                                  {t(`executionCenter.deliveryKind.${delivery.kind}`)}
                                  {delivery.attemptNumber > 1
                                    ? ` · ${t('executionCenter.deliveryAttempt', {
                                        count: delivery.attemptNumber
                                      })}`
                                    : ''}
                                </span>
                                <span className="text-muted-foreground">
                                  {t(`executionCenter.deliveryStatus.${delivery.status}`)}
                                  {delivery.errorCode === 'PROCESS_INTERRUPTED'
                                    ? ` · ${t('executionCenter.deliveryInterrupted')}`
                                    : delivery.errorCode?.startsWith('MANUALLY_CONFIRMED_')
                                      ? ` · ${t('executionCenter.deliveryManuallyConfirmed')}`
                                      : ''}
                                </span>
                              </div>
                              {delivery.status === 'unknown' && (
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="text-muted-foreground">
                                    {t('executionCenter.deliveryVerifyBeforeReconcile')}
                                  </span>
                                  <div className="flex gap-2">
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      disabled={reconcilingDeliveryId === delivery.id}
                                      onClick={() => void reconcileDelivery(delivery.id, 'sent')}
                                    >
                                      {t('executionCenter.deliveryConfirmSent')}
                                    </Button>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      disabled={reconcilingDeliveryId === delivery.id}
                                      onClick={() => void reconcileDelivery(delivery.id, 'failed')}
                                    >
                                      {t('executionCenter.deliveryConfirmFailed')}
                                    </Button>
                                  </div>
                                </div>
                              )}
                              {delivery.status === 'failed' &&
                                delivery.kind === 'channel' &&
                                (!delivery.retryAvailable ? (
                                  <p className="text-xs text-muted-foreground">
                                    {t('executionCenter.deliveryRetryUnavailable')}
                                  </p>
                                ) : !(cronDetail.deliveries ?? []).some(
                                    (attempt) => attempt.retryOfId === delivery.id
                                  ) && selected.status !== 'running' ? (
                                  <div className="space-y-2">
                                    {expandedRetryDeliveryId === delivery.id ? (
                                      <>
                                        <p className="text-xs text-muted-foreground">
                                          {t('executionCenter.deliveryRetryOnly')}
                                        </p>
                                        <Textarea
                                          value={deliveryRetryDraft}
                                          onChange={(event) =>
                                            setDeliveryRetryDraft(
                                              event.target.value.slice(0, 65_536)
                                            )
                                          }
                                          rows={3}
                                          maxLength={65_536}
                                          aria-label={t('executionCenter.deliveryRetryContent')}
                                        />
                                        <div className="flex gap-2">
                                          <Button
                                            size="sm"
                                            disabled={
                                              !deliveryRetryDraft.trim() ||
                                              retryingDeliveryId === delivery.id
                                            }
                                            onClick={() => void retryDelivery(delivery.id)}
                                          >
                                            {retryingDeliveryId === delivery.id
                                              ? t('executionCenter.deliveryRetrying')
                                              : t('executionCenter.deliveryRetry')}
                                          </Button>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            disabled={retryingDeliveryId === delivery.id}
                                            onClick={() => setExpandedRetryDeliveryId(null)}
                                          >
                                            {t('executionCenter.deliveryRetryCancel')}
                                          </Button>
                                        </div>
                                      </>
                                    ) : (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => {
                                          setExpandedRetryDeliveryId(delivery.id)
                                          setDeliveryRetryDraft(cronDetail.run.outputSummary ?? '')
                                        }}
                                      >
                                        {t('executionCenter.deliveryRetry')}
                                      </Button>
                                    )}
                                  </div>
                                ) : null)}
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                    {cronDetail?.messages?.length ? (
                      <RunTranscriptThread messages={cronDetail.messages} />
                    ) : null}
                    {cronDetail?.run?.outputSummary && (
                      <p className="whitespace-pre-wrap rounded bg-muted p-3 text-sm">
                        {cronDetail.run.outputSummary}
                      </p>
                    )}
                    {cronDetail?.run?.error && (
                      <p className="whitespace-pre-wrap text-sm text-destructive">
                        {cronDetail.run.error}
                      </p>
                    )}
                    {cronDetail?.logs?.map((log) => (
                      <div key={log.id} className="rounded border p-2 text-xs">
                        <span className="mr-2 text-muted-foreground">{log.type}</span>
                        {log.content}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {tsSnapshot?.pendingInteractions.map((interaction) => (
                      <div
                        key={interaction.interactionId}
                        className="rounded border border-amber-500/30 p-2 text-xs"
                      >
                        {t('executionCenter.pendingInteraction')}: {interaction.kind}
                      </div>
                    ))}
                    {tsSnapshot?.events.slice(-100).map((event) => (
                      <div key={event.seq} className="flex gap-3 rounded border p-2 text-xs">
                        <span className="shrink-0 text-muted-foreground">
                          {dateTime(event.timestamp)}
                        </span>
                        <span>{event.type}</span>
                      </div>
                    ))}
                    {!tsSnapshot && (
                      <p className="text-xs text-muted-foreground">
                        {t('executionCenter.noDetail')}
                      </p>
                    )}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
