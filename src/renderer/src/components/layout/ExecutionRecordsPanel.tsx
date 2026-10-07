import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock3,
  FileText,
  Loader2,
  Package,
  RefreshCw,
  ShieldCheck,
  XCircle
} from 'lucide-react'
import type { ExecutionRecord } from '../../../../shared/execution-record'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { listExecutionRecords } from '@renderer/lib/ipc/execution-record-bridge'
import { cn } from '@renderer/lib/utils'

function formatTime(value: number | null): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

function statusMeta(status: ExecutionRecord['status']): {
  className: string
  icon: typeof CheckCircle2
} {
  if (status === 'completed') {
    return { className: 'text-emerald-600', icon: CheckCircle2 }
  }
  if (status === 'failed' || status === 'interrupted') {
    return { className: 'text-destructive', icon: XCircle }
  }
  if (status === 'cancelled') {
    return { className: 'text-muted-foreground', icon: XCircle }
  }
  if (status === 'running') {
    return { className: 'text-blue-600', icon: Loader2 }
  }
  return { className: 'text-amber-600', icon: Clock3 }
}

export function ExecutionRecordsPanel(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const setActiveSession = useChatStore((state) => state.setActiveSession)
  const [records, setRecords] = useState<ExecutionRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const requestId = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    if (!workspaceId) {
      setRecords([])
      setLoading(false)
      setError(null)
      return
    }
    const currentRequest = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      const nextRecords = await listExecutionRecords(workspaceId)
      if (currentRequest !== requestId.current) return
      setRecords(nextRecords.records)
    } catch (cause) {
      if (currentRequest !== requestId.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (currentRequest === requestId.current) setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    void load()
  }, [load])

  const title = t('rightPanel.execution', { defaultValue: 'Execution' })
  const sortedRecords = useMemo(
    () => [...records].sort((a, b) => b.startedAt - a.startedAt),
    [records]
  )

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        {t('execution.loading', { defaultValue: 'Loading execution history…' })}
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertCircle className="size-8 text-destructive/70" />
        <div>
          <p className="text-sm font-medium">
            {t('execution.loadFailed', { defaultValue: 'Could not load execution history' })}
          </p>
          <p className="mt-1 max-w-sm break-words text-xs text-muted-foreground">{error}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="mr-2 size-3.5" />
          {t('action.retry', { ns: 'common', defaultValue: 'Retry' })}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border/50 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Activity className="size-4 text-muted-foreground" />
          <h2 className="truncate text-sm font-medium">{title}</h2>
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
            {records.length}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => void load()}
          title={t('action.refresh', { ns: 'common', defaultValue: 'Refresh' })}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>

      {sortedRecords.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
          <Activity className="mb-3 size-9 text-muted-foreground/35" />
          <p className="text-sm text-muted-foreground">
            {t('execution.empty', { defaultValue: 'No executions in this workspace yet' })}
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            {t('execution.emptyHint', {
              defaultValue: 'Chat and scheduled runs will appear here.'
            })}
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {sortedRecords.map((record) => {
            const meta = statusMeta(record.status)
            const StatusIcon = meta.icon
            const recordKey = `${record.source}:${record.id}`
            const expanded = expandedId === recordKey
            return (
              <article
                key={recordKey}
                className="rounded-lg border border-border/60 bg-muted/10 p-3"
              >
                <div className="flex items-start gap-2">
                  <StatusIcon
                    className={cn(
                      'mt-0.5 size-4 shrink-0',
                      meta.className,
                      statusMeta(record.status).icon === Loader2 && 'animate-spin'
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        className="line-clamp-2 text-left text-xs font-medium leading-5 hover:underline"
                        onClick={() => setExpandedId(expanded ? null : recordKey)}
                        aria-expanded={expanded}
                      >
                        {record.title}
                      </button>
                      <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px]">
                        {t(`executionCenter.source.${record.source}`)}
                      </Badge>
                    </div>
                    <p className={cn('mt-0.5 text-[11px]', meta.className)}>
                      {t(`executionCenter.status.${record.status}`)}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {formatTime(record.startedAt)}
                    </p>
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Activity className="size-3" />
                    {record.toolCallCount} tools
                  </span>
                  {record.failedToolCallCount > 0 ? (
                    <span className="text-destructive">{record.failedToolCallCount} failed</span>
                  ) : null}
                  {record.fileChanges.length > 0 ? (
                    <span className="inline-flex items-center gap-1">
                      <FileText className="size-3" />
                      {record.fileChanges.length} files
                    </span>
                  ) : null}
                  {record.artifacts.length > 0 ? (
                    <span className="inline-flex items-center gap-1">
                      <Package className="size-3" />
                      {record.artifacts.length} artifacts
                    </span>
                  ) : null}
                  {record.approvalStatus !== 'not_required' ? (
                    <span className="inline-flex items-center gap-1">
                      <ShieldCheck className="size-3" />
                      {record.approvalStatus}
                    </span>
                  ) : null}
                </div>
                {record.commandSummary ? (
                  <p className="mt-2 truncate rounded bg-muted/50 px-2 py-1 font-mono text-[10px] text-muted-foreground">
                    {record.commandSummary}
                  </p>
                ) : null}
                {record.failureReason ? (
                  <p className="mt-2 line-clamp-2 text-[10px] text-destructive">
                    {record.failureReason}
                  </p>
                ) : null}
                {expanded ? (
                  <div className="mt-3 space-y-2 border-t border-border/50 pt-2 text-[10px] text-muted-foreground">
                    <div className="grid grid-cols-2 gap-2">
                      <span>
                        {t('execution.started', { defaultValue: 'Started' })}:{' '}
                        {formatTime(record.startedAt)}
                      </span>
                      <span>
                        {t('execution.finished', { defaultValue: 'Finished' })}:{' '}
                        {formatTime(record.finishedAt)}
                      </span>
                      <span className="truncate">
                        {t('execution.session', { defaultValue: 'Session' })}:{' '}
                        {record.sessionId ?? '—'}
                      </span>
                      <span className="truncate">
                        {t('execution.ssh', { defaultValue: 'SSH' })}:{' '}
                        {record.sshConnectionId ?? t('execution.local', { defaultValue: 'local' })}
                      </span>
                    </div>
                    {record.fileChanges.length > 0 ? (
                      <div>
                        <p className="mb-1 font-medium text-foreground/80">
                          {t('execution.fileChanges', { defaultValue: 'File changes' })}
                        </p>
                        <ul className="space-y-0.5">
                          {record.fileChanges.slice(0, 8).map((change) => (
                            <li key={`${change.transport}:${change.path}`} className="truncate">
                              {change.operation} · {change.path}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {record.artifacts.length > 0 ? (
                      <div>
                        <p className="mb-1 font-medium text-foreground/80">
                          {t('execution.artifacts', { defaultValue: 'Artifacts' })}
                        </p>
                        <ul className="space-y-0.5">
                          {record.artifacts.slice(0, 8).map((artifact) => (
                            <li key={artifact} className="truncate">
                              {artifact}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {record.sessionId ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-[10px]"
                        onClick={() => setActiveSession(record.sessionId)}
                      >
                        {t('execution.openSession', { defaultValue: 'Open session' })}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
