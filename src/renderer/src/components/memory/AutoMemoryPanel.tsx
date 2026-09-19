import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Play, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Switch } from '@renderer/components/ui/switch'
import { Input } from '@renderer/components/ui/input'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import {
  runDailyMemoryRollup,
  runManualMemoryAutomationForActiveSession,
  undoMemoryAutomationEntry
} from '@renderer/lib/agent/memory-automation'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'
import type {
  MemoryAutomationEntry,
  MemoryAutomationListResult,
  MemoryAutomationTarget,
  MemoryPipelineJob,
  MemoryPipelineListJobsResult,
  MemoryPipelineListRootsResult,
  MemoryRootDescriptor
} from '../../../../shared/memory-automation-types'
import { MemoryPanelRequestGate, type MemoryPanelRequestToken } from './memory-panel-request-gate'

interface AutoMemoryPanelProps {
  variant: 'global' | 'project'
  projectId?: string | null
  projectRootPath?: string | null
  sshConnectionId?: string | null
}

const GLOBAL_TARGETS: MemoryAutomationTarget[] = [
  'global_user',
  'global_memory',
  'global_daily',
  'summary_cache'
]
const PROJECT_TARGETS: MemoryAutomationTarget[] = [
  'project_user',
  'project_memory',
  'project_daily',
  'summary_cache'
]

function statusVariant(
  status: MemoryAutomationEntry['status']
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'written') return 'default'
  if (status === 'error') return 'destructive'
  if (status === 'filtered') return 'secondary'
  return 'outline'
}

function formatEntryTime(entry: MemoryAutomationEntry): string {
  const timestamp = entry.writtenAt ?? entry.updatedAt ?? entry.createdAt
  return new Date(timestamp).toLocaleString()
}

function formatStatusLabel(
  t: ReturnType<typeof useTranslation>['t'],
  status: MemoryAutomationEntry['status']
): string {
  return t(`memory.auto.status.${status}`, { defaultValue: status })
}

function formatKindLabel(
  t: ReturnType<typeof useTranslation>['t'],
  kind: MemoryAutomationEntry['kind']
): string {
  return t(`memory.auto.kind.${kind}`, { defaultValue: kind })
}

function formatTargetLabel(
  t: ReturnType<typeof useTranslation>['t'],
  target: MemoryAutomationEntry['target']
): string {
  return t(`memory.auto.target.${target}`, { defaultValue: target })
}

function formatFilterReasonLabel(
  t: ReturnType<typeof useTranslation>['t'],
  reason: MemoryAutomationEntry['filterReason']
): string | null {
  if (!reason) return null
  return t(`memory.auto.filterReason.${reason}`, { defaultValue: reason })
}

function formatJobKindLabel(t: ReturnType<typeof useTranslation>['t'], kind: string): string {
  return t(`memory.auto.jobKind.${kind}`, { defaultValue: kind })
}

function formatJobStatusLabel(t: ReturnType<typeof useTranslation>['t'], status: string): string {
  return t(`memory.auto.jobStatus.${status}`, { defaultValue: status })
}

export function AutoMemoryPanel({
  variant,
  projectId,
  projectRootPath,
  sshConnectionId
}: AutoMemoryPanelProps): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useSettingsStore()
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const scopeKey = JSON.stringify([
    workspaceId,
    variant,
    projectId,
    projectRootPath,
    sshConnectionId
  ])
  const requestGate = useRef(new MemoryPanelRequestGate())
  requestGate.current.setScope(scopeKey)
  const [loadedRequest, setLoadedRequest] = useState<MemoryPanelRequestToken | null>(null)
  const [entries, setEntries] = useState<MemoryAutomationEntry[]>([])
  const [roots, setRoots] = useState<MemoryRootDescriptor[]>([])
  const [jobs, setJobs] = useState<MemoryPipelineJob[]>([])
  const [loadingRequest, setLoadingRequest] = useState<MemoryPanelRequestToken | null>(null)
  const [running, setRunning] = useState(false)
  const [undoingId, setUndoingId] = useState<string | null>(null)
  const targets = useMemo(
    () => (variant === 'project' ? PROJECT_TARGETS : GLOBAL_TARGETS),
    [variant]
  )
  const loading =
    loadingRequest !== null && requestGate.current.accepts(loadingRequest, workspaceId)
  const showLoaded =
    loadedRequest !== null && requestGate.current.accepts(loadedRequest, workspaceId)
  const visibleEntries = showLoaded ? entries : []
  const visibleRoots = showLoaded ? roots : []
  const visibleJobs = showLoaded ? jobs : []

  const loadEntries = useCallback(async (): Promise<void> => {
    const request = requestGate.current.begin(scopeKey, workspaceId)
    const isCurrent = (): boolean =>
      requestGate.current.accepts(request, useWorkspaceStore.getState().activeWorkspaceId)
    setLoadingRequest(request)
    try {
      const result = (await ipcClient.invoke(IPC.MEMORY_AUTOMATION_LIST, {
        workspaceId,
        targets,
        rootScope: variant === 'project' ? 'project' : 'global',
        targetPathIncludes: variant === 'project' ? projectRootPath : undefined,
        limit: 30
      })) as MemoryAutomationListResult
      const rootResult = (await ipcClient.invoke(IPC.MEMORY_PIPELINE_LIST_ROOTS, {
        workspaceId,
        scope: variant === 'project' ? 'project' : 'global',
        rootPath: variant === 'project' && projectRootPath ? undefined : undefined,
        workingFolder: variant === 'project' ? projectRootPath : undefined,
        sshConnectionId: variant === 'project' ? sshConnectionId : undefined
      })) as MemoryPipelineListRootsResult
      const scopedRoots = (rootResult.roots ?? []).filter(
        (root) => root.workspaceId === workspaceId
      )
      const rootIds = new Set(scopedRoots.map((root) => root.id))
      const jobResult = (await ipcClient.invoke(IPC.MEMORY_PIPELINE_LIST_JOBS, {
        workspaceId,
        limit: 20
      })) as MemoryPipelineListJobsResult
      if (!isCurrent()) return
      setEntries(result.entries.filter((entry) => entry.workspaceId === workspaceId))
      setRoots(scopedRoots)
      setJobs(
        (jobResult.jobs ?? [])
          .filter((job) => job.workspaceId === workspaceId)
          .filter((job) =>
            job.memoryRootId ? rootIds.has(job.memoryRootId) : variant === 'global'
          )
      )
      setLoadedRequest(request)
    } catch (error) {
      if (!isCurrent()) return
      toast.error(
        t('memory.auto.loadFailed', {
          defaultValue: 'Failed to load auto memory records'
        }),
        {
          description: error instanceof Error ? error.message : String(error)
        }
      )
    } finally {
      if (isCurrent()) setLoadingRequest(null)
    }
  }, [projectRootPath, scopeKey, sshConnectionId, t, targets, variant, workspaceId])

  useEffect(() => {
    void loadEntries()
  }, [loadEntries])

  useEffect(() => {
    const gate = requestGate.current
    return () => gate.setScope('')
  }, [])

  const handleRunSession = useCallback(async (): Promise<void> => {
    setRunning(true)
    try {
      await runManualMemoryAutomationForActiveSession()
      await loadEntries()
      toast.success(
        t('memory.auto.sessionRunComplete', {
          defaultValue: 'Auto memory run completed'
        })
      )
    } catch (error) {
      toast.error(
        t('memory.auto.sessionRunFailed', {
          defaultValue: 'Auto memory run failed'
        }),
        {
          description: error instanceof Error ? error.message : String(error)
        }
      )
    } finally {
      setRunning(false)
    }
  }, [loadEntries, t])

  const handleRunRollup = useCallback(async (): Promise<void> => {
    setRunning(true)
    try {
      await runDailyMemoryRollup({
        projectId: variant === 'project' ? projectId : undefined,
        projectRootPath: variant === 'project' ? projectRootPath : undefined,
        sshConnectionId: variant === 'project' ? sshConnectionId : undefined,
        global: variant === 'global'
      })
      await loadEntries()
      toast.success(
        t('memory.auto.rollupComplete', {
          defaultValue: 'Daily rollup completed'
        })
      )
    } catch (error) {
      toast.error(
        t('memory.auto.rollupFailed', {
          defaultValue: 'Daily rollup failed'
        }),
        {
          description: error instanceof Error ? error.message : String(error)
        }
      )
    } finally {
      setRunning(false)
    }
  }, [loadEntries, projectId, projectRootPath, sshConnectionId, t, variant])

  const handleUndo = useCallback(
    async (entry: MemoryAutomationEntry): Promise<void> => {
      setUndoingId(entry.id)
      try {
        const result = await undoMemoryAutomationEntry(entry)
        if (!result.success) {
          throw new Error(result.error ?? 'Undo failed')
        }
        await loadEntries()
        toast.success(
          t('memory.auto.undoComplete', {
            defaultValue: 'Memory write undone'
          })
        )
      } catch (error) {
        toast.error(
          t('memory.auto.undoFailed', {
            defaultValue: 'Failed to undo memory write'
          }),
          {
            description: error instanceof Error ? error.message : String(error)
          }
        )
      } finally {
        setUndoingId(null)
      }
    },
    [loadEntries, t]
  )

  return (
    <section className="space-y-4 rounded-lg border border-border/60 bg-muted/15 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">
              {t('memory.auto.title', { defaultValue: 'Auto Memory' })}
            </h3>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('memory.auto.subtitle', {
              defaultValue:
                'Automatically extracts safe, deduplicated memory from completed main sessions.'
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1">
            <span className="text-xs text-muted-foreground">
              {t('memory.auto.enabled', { defaultValue: 'Enabled' })}
            </span>
            <Switch
              checked={settings.memoryAutomationEnabled}
              onCheckedChange={(checked) =>
                settings.updateSettings({
                  memoryAutomationEnabled: checked,
                  memoryUseMemories: checked,
                  memoryGenerateMemories: checked
                })
              }
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => void loadEntries()}
            disabled={loading || running}
          >
            <RefreshCw className={`mr-1.5 size-3.5 ${loading ? 'animate-spin' : ''}`} />
            {t('memory.auto.refresh', { defaultValue: 'Refresh' })}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
        <label className="space-y-1">
          <span className="text-xs font-medium">
            {t('memory.auto.summaryBudget', { defaultValue: 'Summary budget tokens' })}
          </span>
          <Input
            type="number"
            min={1000}
            step={500}
            value={settings.memoryAutomationSummaryBudgetTokens}
            onChange={(event) =>
              settings.updateSettings({
                memoryAutomationSummaryBudgetTokens: Number(event.target.value) || 12000,
                memorySummaryBudgetTokens: Number(event.target.value) || 12000
              })
            }
            className="h-8 max-w-[180px] text-xs"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => void handleRunSession()}
            disabled={running || !settings.memoryAutomationEnabled}
          >
            {running ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <Play className="mr-1.5 size-3.5" />
            )}
            {t('memory.auto.runSession', { defaultValue: 'Run Session' })}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => void handleRunRollup()}
            disabled={
              running ||
              !settings.memoryAutomationEnabled ||
              !settings.memoryAutomationDailyRollupEnabled ||
              (variant === 'project' && !projectRootPath)
            }
          >
            {running ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 size-3.5" />
            )}
            {t('memory.auto.runRollup', { defaultValue: 'Run Rollup' })}
          </Button>
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch
          checked={settings.memoryAutomationDailyRollupEnabled}
          onCheckedChange={(checked) =>
            settings.updateSettings({
              memoryAutomationDailyRollupEnabled: checked,
              memoryDailyRollupEnabled: checked
            })
          }
        />
        {t('memory.auto.dailyRollupEnabled', {
          defaultValue: 'Promote yesterday daily memory into durable memory when useful'
        })}
      </label>

      <div className="grid gap-2 md:grid-cols-3">
        <div className="rounded-md border border-border/60 bg-background/70 p-3">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {t('memory.auto.roots', { defaultValue: 'Roots' })}
          </p>
          <p className="mt-1 text-sm font-medium">{visibleRoots.length}</p>
          <p className="mt-1 break-all text-[11px] text-muted-foreground">
            {visibleRoots[0]?.rootPath ?? t('memory.auto.noRoot', { defaultValue: 'No root yet' })}
          </p>
        </div>
        <div className="rounded-md border border-border/60 bg-background/70 p-3">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {t('memory.auto.jobs', { defaultValue: 'Jobs' })}
          </p>
          <p className="mt-1 text-sm font-medium">{visibleJobs.length}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {visibleJobs[0]
              ? `${formatJobKindLabel(t, visibleJobs[0].kind)} / ${formatJobStatusLabel(t, visibleJobs[0].status)}`
              : t('memory.auto.noJobs', { defaultValue: 'No pipeline jobs yet' })}
          </p>
        </div>
        <div className="rounded-md border border-border/60 bg-background/70 p-3">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {t('memory.auto.scopeMode', { defaultValue: 'Scope mode' })}
          </p>
          <p className="mt-1 text-sm font-medium">
            {t('memory.auto.hybrid', { defaultValue: 'Hybrid' })}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t('memory.auto.hybridHint', {
              defaultValue: 'Global plus current project; project memory wins conflicts.'
            })}
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {visibleEntries.length === 0 ? (
          <p className="rounded-md border border-dashed border-border/70 px-3 py-3 text-xs text-muted-foreground">
            {t('memory.auto.empty', { defaultValue: 'No auto memory records yet.' })}
          </p>
        ) : (
          visibleEntries.map((entry) => (
            <div
              key={entry.id}
              className="grid gap-2 rounded-md border border-border/60 bg-background/70 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant={statusVariant(entry.status)}>
                    {formatStatusLabel(t, entry.status)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {formatKindLabel(t, entry.kind)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatTargetLabel(t, entry.target)}
                  </span>
                  {entry.rootScope && (
                    <Badge variant="outline" className="text-[10px]">
                      {entry.rootScope}
                    </Badge>
                  )}
                </div>
                <span className="text-[11px] text-muted-foreground">{formatEntryTime(entry)}</span>
              </div>
              <p className="text-sm leading-5 text-foreground/90">{entry.content}</p>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 break-all text-[11px] text-muted-foreground">
                  {entry.filterReason
                    ? `${formatFilterReasonLabel(t, entry.filterReason)}${
                        entry.error ? `: ${entry.error}` : ''
                      }`
                    : entry.memoryRootId
                      ? `${entry.memoryRootId}${entry.targetPath ? ` / ${entry.targetPath}` : ''}`
                      : entry.targetPath ||
                        t('memory.auto.noTargetPath', { defaultValue: 'No target path' })}
                </p>
                {entry.status === 'written' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => void handleUndo(entry)}
                    disabled={undoingId === entry.id}
                  >
                    {undoingId === entry.id ? (
                      <Loader2 className="mr-1.5 size-3 animate-spin" />
                    ) : (
                      <RotateCcw className="mr-1.5 size-3" />
                    )}
                    {t('memory.auto.undo', { defaultValue: 'Undo' })}
                  </Button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
