import { useCallback, useEffect, useState } from 'react'
import { MousePointer2, Play, Save, Square, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'
import {
  SettingsEmptyState,
  SettingsInfoNotice,
  SettingsPageHeader,
  SettingsSafetyNotice,
  SettingsSectionCard
} from './settings-primitives'
import type {
  DesktopFlow,
  DesktopFlowRun,
  DesktopFlowRecordingStatus,
  DesktopFlowReplayResult
} from '../../../../shared/desktop-flow'

export function DesktopAutomationPanel(): React.JSX.Element {
  const { t, i18n } = useTranslation('settings')
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const [name, setName] = useState(() => t('desktopAutomation.defaultFlowName'))
  const [status, setStatus] = useState<DesktopFlowRecordingStatus | null>(null)
  const [current, setCurrent] = useState<DesktopFlow | null>(null)
  const [flows, setFlows] = useState<DesktopFlow[]>([])
  const [runs, setRuns] = useState<DesktopFlowRun[]>([])
  const [replaying, setReplaying] = useState(false)
  const [lastReplay, setLastReplay] = useState<DesktopFlowReplayResult | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setLoadError(null)
    try {
      const availability = (await ipcClient.invoke('desktop-flow:sync', { workspaceId })) as {
        available: boolean
      }
      if (!availability.available) throw new Error('DESKTOP_FLOW_WORKSPACE_UNAVAILABLE')
      const nextStatus = (await ipcClient.invoke('desktop-recorder:status', {
        workspaceId
      })) as DesktopFlowRecordingStatus
      const nextCurrent = (await ipcClient.invoke('desktop-recorder:current', {
        workspaceId
      })) as DesktopFlow | null
      const nextFlows = (await ipcClient.invoke('desktop-flow:list', {
        workspaceId
      })) as DesktopFlow[]
      const nextRuns = (await ipcClient.invoke('desktop-flow:runs-list', {
        workspaceId
      })) as DesktopFlowRun[]
      if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return
      setStatus(nextStatus)
      setCurrent(nextCurrent)
      setFlows(nextFlows)
      setRuns(nextRuns)
    } catch (error) {
      if (useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return
      setStatus(null)
      setCurrent(null)
      setFlows([])
      setRuns([])
      setLoadError(
        String(error).includes('DESKTOP_FLOW_WORKSPACE_UNAVAILABLE')
          ? 'desktopAutomation.errors.workspaceUnavailable'
          : 'desktopAutomation.errors.loadFailed'
      )
    }
  }, [workspaceId])

  useEffect(() => {
    setStatus(null)
    setCurrent(null)
    setFlows([])
    setRuns([])
    setLastReplay(null)
    void refresh()
    // The TS repository owns desktop flows. The sync endpoint only checks
    // workspace availability; refreshing it again would not import data.
  }, [refresh, workspaceId])

  async function start(): Promise<void> {
    try {
      await ipcClient.invoke('desktop-recorder:start', { name, workspaceId })
      await refresh()
    } catch {
      toast.error(t('desktopAutomation.errors.startFailed'))
    }
  }

  async function stopAndSave(): Promise<void> {
    try {
      const flow = (await ipcClient.invoke('desktop-recorder:stop', {
        workspaceId
      })) as DesktopFlow | null
      if (!flow) throw new Error('DESKTOP_FLOW_RECORDING_UNAVAILABLE')
      await refresh()
    } catch {
      toast.error(t('desktopAutomation.errors.stopFailed'))
      await refresh()
    }
  }

  async function replay(flow: DesktopFlow): Promise<void> {
    setReplaying(true)
    try {
      setLastReplay(
        (await ipcClient.invoke('desktop-flow:replay', {
          flow,
          workspaceId,
          locale: i18n.resolvedLanguage ?? i18n.language,
          verifyScreenshots: true
        })) as DesktopFlowReplayResult
      )
      await refresh()
    } catch {
      toast.error(t('desktopAutomation.errors.replayFailed'))
      await refresh()
    } finally {
      setReplaying(false)
    }
  }

  return (
    <div className="w-full space-y-3">
      <SettingsPageHeader
        icon={MousePointer2}
        title={t('desktopAutomation.title')}
        description={t('desktopAutomation.subtitle')}
      />
      <SettingsSafetyNotice>{t('desktopAutomation.safetyNotice')}</SettingsSafetyNotice>
      <SettingsSectionCard title={t('desktopAutomation.recording.title')}>
        <div className="space-y-3">
          <div className="space-y-2">
            <label
              htmlFor="desktop-flow-name"
              className="block text-sm font-medium text-foreground/90"
            >
              {t('desktopAutomation.flowName')}
            </label>
            <p
              id="desktop-flow-name-description"
              className="text-[0.8125rem] text-muted-foreground"
            >
              {t('desktopAutomation.flowNameDescription')}
            </p>
            <Input
              id="desktop-flow-name"
              aria-describedby="desktop-flow-name-description"
              className="w-full max-w-sm"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={Boolean(status?.recording)} onClick={() => void start()}>
              <Play className="mr-2 size-4" />
              {t('desktopAutomation.start')}
            </Button>
            <Button
              variant="destructive"
              disabled={!status?.recording}
              onClick={() => void stopAndSave()}
            >
              <Square className="mr-2 size-4" />
              {t('desktopAutomation.stopAndSave')}
            </Button>
          </div>
          {status ? (
            <SettingsInfoNotice>
              {t(
                status.recording
                  ? 'desktopAutomation.status.recording'
                  : 'desktopAutomation.status.idle',
                { count: status.stepCount }
              )}
            </SettingsInfoNotice>
          ) : null}
        </div>
      </SettingsSectionCard>
      {loadError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 p-3 text-sm"
        >
          <span className="min-w-0 flex-1">{t(loadError)}</span>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            {t('desktopAutomation.errors.retry')}
          </Button>
        </div>
      ) : null}
      {lastReplay ? (
        <SettingsInfoNotice>
          {lastReplay.success
            ? t('desktopAutomation.replay.success', {
                count: lastReplay.receipts?.filter((receipt) => receipt.changed).length ?? 0
              })
            : t('desktopAutomation.replay.failed', {
                error: lastReplay.error ?? t('desktopAutomation.unknownError')
              })}
        </SettingsInfoNotice>
      ) : null}
      {current ? (
        <SettingsSectionCard
          title={t('desktopAutomation.current.title')}
          description={t('desktopAutomation.current.description')}
          action={
            !status?.recording ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void ipcClient
                    .invoke('desktop-flow:save', current)
                    .then(refresh)
                    .catch(() => toast.error(t('desktopAutomation.errors.saveFailed')))
                }}
              >
                <Save className="mr-2 size-4" />
                {t('desktopAutomation.saveCurrent')}
              </Button>
            ) : undefined
          }
        >
          <p className="text-sm text-muted-foreground">{current.name}</p>
        </SettingsSectionCard>
      ) : null}
      <SettingsSectionCard
        title={t('desktopAutomation.saved.title')}
        description={t('desktopAutomation.saved.description')}
      >
        <div className="space-y-2">
          {replaying ? (
            <Button
              variant="destructive"
              onClick={() => {
                void ipcClient
                  .invoke('desktop-flow:cancel', { workspaceId })
                  .then((result) => {
                    if (!(result as { success?: boolean })?.success)
                      toast.error(t('desktopAutomation.errors.cancelFailed'))
                  })
                  .catch(() => toast.error(t('desktopAutomation.errors.cancelFailed')))
              }}
            >
              <X className="mr-2 size-4" />
              {t('desktopAutomation.cancelReplay')}
            </Button>
          ) : null}
          {flows.map((flow) => (
            <div
              key={flow.id}
              className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm">
                {t('desktopAutomation.flowSummary', { name: flow.name, count: flow.steps.length })}
                {flow.requiresReview || flow.steps.some((step) => step.type === 'type') ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {t('desktopAutomation.reviewRequired', {
                      defaultValue: 'Typing steps cannot be replayed; re-record without typing.'
                    })}
                  </span>
                ) : null}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={flow.requiresReview || flow.steps.some((step) => step.type === 'type')}
                onClick={() => void replay(flow)}
              >
                <Play className="mr-1 size-3" />
                {t('desktopAutomation.run')}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t('desktopAutomation.delete', { name: flow.name })}
                onClick={() => {
                  void ipcClient
                    .invoke('desktop-flow:delete', { id: flow.id, workspaceId })
                    .then(async (result) => {
                      if (!(result as { success?: boolean })?.success)
                        throw new Error('DESKTOP_FLOW_DELETE_FAILED')
                      await refresh()
                    })
                    .catch(() => toast.error(t('desktopAutomation.errors.deleteFailed')))
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          {!flows.length ? (
            <SettingsEmptyState>{t('desktopAutomation.saved.empty')}</SettingsEmptyState>
          ) : null}
          {runs.length > 0 ? (
            <div className="mt-4 border-t border-border/60 pt-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                {t('desktopAutomation.runs.title', { defaultValue: 'Recent runs' })}
              </p>
              {runs.slice(0, 5).map((run) => (
                <p key={run.id} className="truncate text-xs text-muted-foreground">
                  {flows.find((flow) => flow.id === run.flowId)?.name ?? run.flowId} ·{' '}
                  {t(`desktopAutomation.runs.${run.state}`, { defaultValue: run.state })} ·{' '}
                  {new Date(run.startedAt).toLocaleString()}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      </SettingsSectionCard>
    </div>
  )
}
