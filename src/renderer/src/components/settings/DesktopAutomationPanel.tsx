import { useCallback, useEffect, useState } from 'react'
import { MousePointer2, Play, Save, Square, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'
import {
  SETTINGS_PANEL_CLASS,
  SettingsEmptyState,
  SettingsField,
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
  const { t } = useTranslation('settings')
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const [name, setName] = useState(() => t('desktopAutomation.defaultFlowName'))
  const [status, setStatus] = useState<DesktopFlowRecordingStatus | null>(null)
  const [current, setCurrent] = useState<DesktopFlow | null>(null)
  const [flows, setFlows] = useState<DesktopFlow[]>([])
  const [runs, setRuns] = useState<DesktopFlowRun[]>([])
  const [replaying, setReplaying] = useState(false)
  const [lastReplay, setLastReplay] = useState<DesktopFlowReplayResult | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
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
  }, [workspaceId])

  useEffect(() => {
    let cancelled = false
    setStatus(null)
    setCurrent(null)
    setFlows([])
    setRuns([])
    setLastReplay(null)
    void refresh()
    void (async () => {
      try {
        for (let round = 0; round < 10; round++) {
          if (cancelled || useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return
          const sync = (await ipcClient.invoke('desktop-flow:sync', { workspaceId })) as {
            available: boolean
            savedFlows: number
            deletedFlows: number
            savedRuns: number
            failed: number
          }
          const attempted = sync.savedFlows + sync.deletedFlows + sync.savedRuns + sync.failed
          if (!sync.available || attempted < 20) break
        }
        if (!cancelled && useWorkspaceStore.getState().activeWorkspaceId === workspaceId)
          await refresh()
      } catch {
        // The local flow list remains usable while Native is unavailable.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refresh, workspaceId])

  async function start(): Promise<void> {
    await ipcClient.invoke('desktop-recorder:start', { name, workspaceId })
    await refresh()
  }

  async function stopAndSave(): Promise<void> {
    const flow = (await ipcClient.invoke('desktop-recorder:stop', {
      workspaceId
    })) as DesktopFlow | null
    if (flow) await ipcClient.invoke('desktop-flow:save', flow)
    await refresh()
  }

  async function replay(flow: DesktopFlow): Promise<void> {
    setReplaying(true)
    try {
      setLastReplay(
        (await ipcClient.invoke('desktop-flow:replay', {
          flow,
          workspaceId,
          verifyScreenshots: true
        })) as DesktopFlowReplayResult
      )
      await refresh()
    } finally {
      setReplaying(false)
    }
  }

  return (
    <div className={SETTINGS_PANEL_CLASS}>
      <SettingsPageHeader
        icon={MousePointer2}
        title={t('desktopAutomation.title')}
        description={t('desktopAutomation.subtitle')}
      />
      <SettingsSafetyNotice>{t('desktopAutomation.safetyNotice')}</SettingsSafetyNotice>
      <SettingsSectionCard
        title={t('desktopAutomation.recording.title')}
        description={t('desktopAutomation.recording.description')}
      >
        <div className="space-y-4">
          <SettingsField
            label={t('desktopAutomation.flowName')}
            description={t('desktopAutomation.flowNameDescription')}
          >
            <Input
              className="w-72"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </SettingsField>
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
                onClick={() => void ipcClient.invoke('desktop-flow:save', current).then(refresh)}
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
              onClick={() => void ipcClient.invoke('desktop-flow:cancel', { workspaceId })}
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
                onClick={async () => {
                  await ipcClient.invoke('desktop-flow:delete', { id: flow.id, workspaceId })
                  await refresh()
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
