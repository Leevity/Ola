import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, CloudSync, Loader2, RefreshCw, Upload, Download } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Separator } from '@renderer/components/ui/separator'
import { Switch } from '@renderer/components/ui/switch'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { useChatStore } from '@renderer/stores/chat-store'
import type {
  SyncConfig,
  SyncConflict,
  SyncConflictResolution,
  SyncProviderConfig,
  SyncRunMode,
  SyncRunSummary,
  SyncStatus
} from '../../../../shared/sync-types'

function createFallbackProvider(): SyncProviderConfig {
  return {
    id: 'webdav',
    type: 'webdav',
    enabled: true,
    webdav: {
      displayName: 'WebDAV',
      serverUrl: '',
      username: '',
      password: '',
      remoteDir: 'ola-sync/v1',
      autoSyncEnabled: false,
      syncIntervalMinutes: 30,
      backupRetention: 10
    }
  }
}

function statusVariant(status?: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'success') return 'default'
  if (status === 'error' || status === 'conflict') return 'destructive'
  if (status === 'running') return 'secondary'
  return 'outline'
}

function formatTime(value?: number | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString()
}

function summarizeConflict(conflict: SyncConflict): string {
  if (conflict.domain === 'file') return conflict.recordId
  if (conflict.domain.startsWith('db:')) return `${conflict.domain.slice(3)} ${conflict.recordId}`
  return `${conflict.domain} ${conflict.recordId}`
}

export function SyncPage(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [config, setConfig] = useState<SyncConfig | null>(null)
  const [provider, setProvider] = useState<SyncProviderConfig>(createFallbackProvider)
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [runningMode, setRunningMode] = useState<SyncRunMode | null>(null)
  const [choiceByConflictId, setChoiceByConflictId] = useState<Record<string, 'local' | 'remote'>>(
    {}
  )

  const activeProviderId = config?.activeProviderId ?? provider.id
  const pendingConflicts = useMemo(() => status?.pendingConflicts ?? [], [status?.pendingConflicts])
  const lastRun = status?.lastRun ?? config?.lastRun ?? null

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const nextConfig = (await ipcClient.invoke(IPC.SYNC_CONFIG_GET)) as SyncConfig
      const nextStatus = (await ipcClient.invoke(IPC.SYNC_STATUS)) as SyncStatus
      const active =
        nextConfig.providers.find((item) => item.id === nextConfig.activeProviderId) ??
        nextConfig.providers[0] ??
        createFallbackProvider()
      setConfig(nextConfig)
      setProvider(active)
      setStatus(nextStatus)
    } catch (error) {
      toast.error(
        t('sync.toast.loadFailed', {
          defaultValue: 'Failed to load sync settings: {{error}}',
          error: error instanceof Error ? error.message : String(error)
        })
      )
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
    const offStatus = ipcClient.on(IPC.SYNC_STATUS_CHANGED, (payload) => {
      setStatus(payload as SyncStatus)
    })
    const offFinished = ipcClient.on(IPC.SYNC_RUN_FINISHED, (payload) => {
      const summary = payload as SyncRunSummary
      setRunningMode(null)
      setStatus((current) =>
        current ? { ...current, lastRun: summary, running: false, status: summary.status } : current
      )
      if (summary.status === 'success') {
        toast.success(t('sync.toast.success', { defaultValue: 'Sync completed' }))
        void useChatStore.getState().loadFromDb()
      } else if (summary.status === 'conflict') {
        toast.error(t('sync.toast.conflict', { defaultValue: 'Sync needs conflict resolution' }))
      } else if (summary.error) {
        toast.error(summary.error)
      }
    })
    return () => {
      offStatus()
      offFinished()
    }
  }, [load, t])

  const mergedConfig = useMemo<SyncConfig>(() => {
    const base: SyncConfig = config ?? {
      deviceId: status?.deviceId ?? '',
      activeProviderId: provider.id,
      providers: [provider],
      lastRun: null
    }
    const providers = base.providers.some((item) => item.id === provider.id)
      ? base.providers.map((item) => (item.id === provider.id ? provider : item))
      : [...base.providers, provider]
    return {
      ...base,
      activeProviderId,
      providers
    }
  }, [activeProviderId, config, provider, status?.deviceId])

  const updateWebDav = useCallback((patch: Partial<SyncProviderConfig['webdav']>) => {
    setProvider((current) => ({
      ...current,
      webdav: {
        ...current.webdav,
        ...patch
      }
    }))
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const nextConfig = (await ipcClient.invoke(IPC.SYNC_CONFIG_SET, mergedConfig)) as SyncConfig
      setConfig(nextConfig)
      toast.success(t('sync.toast.saved', { defaultValue: 'Sync settings saved' }))
    } catch (error) {
      toast.error(
        t('sync.toast.saveFailed', {
          defaultValue: 'Failed to save sync settings: {{error}}',
          error: error instanceof Error ? error.message : String(error)
        })
      )
    } finally {
      setSaving(false)
    }
  }, [mergedConfig, t])

  const handleTest = useCallback(async () => {
    setTesting(true)
    try {
      const result = (await ipcClient.invoke(IPC.SYNC_CONNECTION_TEST, provider)) as {
        success: boolean
        error?: string
      }
      if (result.success) {
        toast.success(t('sync.toast.testSuccess', { defaultValue: 'WebDAV connection works' }))
      } else {
        toast.error(
          result.error ?? t('sync.toast.testFailed', { defaultValue: 'Connection failed' })
        )
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setTesting(false)
    }
  }, [provider, t])

  const runSync = useCallback(
    async (mode: SyncRunMode) => {
      if (mode !== 'sync') {
        const ok = await confirm({
          title:
            mode === 'push'
              ? t('sync.confirm.pushTitle', { defaultValue: 'Upload local data to WebDAV?' })
              : t('sync.confirm.pullTitle', { defaultValue: 'Pull remote data into this device?' }),
          description:
            mode === 'push'
              ? t('sync.confirm.pushDesc', {
                  defaultValue: 'This overwrites the remote sync state after creating a backup.'
                })
              : t('sync.confirm.pullDesc', {
                  defaultValue: 'Remote records are applied to this device.'
                }),
          confirmLabel: t('sync.confirm.confirm', { defaultValue: 'Continue' })
        })
        if (!ok) return
      }
      setRunningMode(mode)
      try {
        const summary = (await ipcClient.invoke(IPC.SYNC_RUN, { mode })) as SyncRunSummary
        setStatus((current) =>
          current ? { ...current, lastRun: summary, status: summary.status } : current
        )
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
      } finally {
        setRunningMode(null)
      }
    },
    [t]
  )

  const handleResolveConflicts = useCallback(async () => {
    const resolutions: SyncConflictResolution[] = pendingConflicts.map((conflict) => ({
      conflictId: conflict.id,
      choice: choiceByConflictId[conflict.id]
    }))
    if (resolutions.some((resolution) => !resolution.choice)) {
      toast.error(
        t('sync.toast.chooseAll', { defaultValue: 'Choose a resolution for every conflict' })
      )
      return
    }
    setRunningMode('sync')
    try {
      await ipcClient.invoke(IPC.SYNC_CONFLICTS_RESOLVE, { resolutions })
      setChoiceByConflictId({})
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setRunningMode(null)
    }
  }, [choiceByConflictId, pendingConflicts, t])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        {t('sync.loading', { defaultValue: 'Loading sync settings...' })}
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <CloudSync className="size-5 text-primary" />
              <h1 className="text-xl font-semibold">{t('sync.title', { defaultValue: 'Sync' })}</h1>
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t('sync.subtitle', {
                defaultValue: 'Record-level Ola data sync with WebDAV.'
              })}
            </p>
          </div>
          <Badge variant={statusVariant(status?.status)}>{status?.status ?? 'idle'}</Badge>
        </header>

        <section className="rounded-lg border border-border/70 bg-background p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">
                {t('sync.provider.title', { defaultValue: 'Provider' })}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t('sync.provider.subtitle', { defaultValue: 'WebDAV is available in v1.' })}
              </p>
            </div>
            <Badge variant="outline">WebDAV</Badge>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-xs font-medium">
                {t('sync.form.displayName', { defaultValue: 'Display name' })}
              </span>
              <Input
                value={provider.webdav.displayName}
                onChange={(event) => updateWebDav({ displayName: event.target.value })}
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-medium">
                {t('sync.form.serverUrl', { defaultValue: 'Server URL' })}
              </span>
              <Input
                value={provider.webdav.serverUrl}
                placeholder="https://example.com/dav"
                onChange={(event) => updateWebDav({ serverUrl: event.target.value })}
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-medium">
                {t('sync.form.username', { defaultValue: 'Username' })}
              </span>
              <Input
                value={provider.webdav.username}
                onChange={(event) => updateWebDav({ username: event.target.value })}
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-medium">
                {t('sync.form.password', { defaultValue: 'Password / app password' })}
              </span>
              <Input
                type="password"
                value={provider.webdav.password}
                onChange={(event) => updateWebDav({ password: event.target.value })}
              />
            </label>
            <label className="space-y-1.5 md:col-span-2">
              <span className="text-xs font-medium">
                {t('sync.form.remoteDir', { defaultValue: 'Remote directory' })}
              </span>
              <Input
                value={provider.webdav.remoteDir}
                onChange={(event) => updateWebDav({ remoteDir: event.target.value })}
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-medium">
                {t('sync.form.interval', { defaultValue: 'Auto-sync interval (minutes)' })}
              </span>
              <Input
                type="number"
                min={5}
                value={provider.webdav.syncIntervalMinutes}
                onChange={(event) =>
                  updateWebDav({ syncIntervalMinutes: Number(event.target.value) || 30 })
                }
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-medium">
                {t('sync.form.retention', { defaultValue: 'Remote backups to keep' })}
              </span>
              <Input
                type="number"
                min={0}
                value={provider.webdav.backupRetention}
                onChange={(event) =>
                  updateWebDav({ backupRetention: Number(event.target.value) || 0 })
                }
              />
            </label>
          </div>

          <Separator className="my-4" />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Switch
                checked={provider.webdav.autoSyncEnabled}
                onCheckedChange={(checked) => updateWebDav({ autoSyncEnabled: checked })}
              />
              <div>
                <p className="text-sm font-medium">
                  {t('sync.form.autoSync', { defaultValue: 'Auto sync' })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('sync.form.autoSyncDesc', {
                    defaultValue: 'Runs on the configured interval.'
                  })}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleTest()}
                disabled={testing}
              >
                {testing && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                {t('sync.actions.test', { defaultValue: 'Test' })}
              </Button>
              <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
                {saving && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                {t('sync.actions.save', { defaultValue: 'Save' })}
              </Button>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-border/70 bg-background p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">
                {t('sync.status.title', { defaultValue: 'Status' })}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t('sync.status.device', {
                  defaultValue: 'Device: {{deviceId}}',
                  deviceId: status?.deviceId ?? config?.deviceId ?? '—'
                })}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runSync('pull')}
                disabled={!!runningMode || status?.running}
              >
                <Download className="mr-1 size-3.5" />
                {t('sync.actions.pull', { defaultValue: 'Pull' })}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runSync('push')}
                disabled={!!runningMode || status?.running}
              >
                <Upload className="mr-1 size-3.5" />
                {t('sync.actions.push', { defaultValue: 'Push' })}
              </Button>
              <Button
                size="sm"
                onClick={() => void runSync('sync')}
                disabled={!!runningMode || status?.running}
              >
                {runningMode === 'sync' ? (
                  <Loader2 className="mr-1 size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 size-3.5" />
                )}
                {t('sync.actions.syncNow', { defaultValue: 'Sync now' })}
              </Button>
            </div>
          </div>

          <div className="grid gap-3 text-sm md:grid-cols-4">
            <div className="rounded-md border border-border/60 p-3">
              <p className="text-xs text-muted-foreground">
                {t('sync.status.lastRun', { defaultValue: 'Last run' })}
              </p>
              <p className="mt-1 font-medium">{formatTime(lastRun?.finishedAt)}</p>
            </div>
            <div className="rounded-md border border-border/60 p-3">
              <p className="text-xs text-muted-foreground">
                {t('sync.status.remoteUpdated', { defaultValue: 'Remote updated' })}
              </p>
              <p className="mt-1 font-medium">{formatTime(lastRun?.remoteUpdatedAt)}</p>
            </div>
            <div className="rounded-md border border-border/60 p-3">
              <p className="text-xs text-muted-foreground">
                {t('sync.status.downloaded', { defaultValue: 'Downloaded' })}
              </p>
              <p className="mt-1 font-medium">{lastRun?.downloadedRecords ?? 0}</p>
            </div>
            <div className="rounded-md border border-border/60 p-3">
              <p className="text-xs text-muted-foreground">
                {t('sync.status.conflicts', { defaultValue: 'Conflicts' })}
              </p>
              <p className="mt-1 font-medium">{lastRun?.conflicts ?? pendingConflicts.length}</p>
            </div>
          </div>

          {lastRun?.error && (
            <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {lastRun.error}
            </p>
          )}
          {lastRun?.status === 'success' && (
            <p className="mt-3 flex items-center gap-2 rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600">
              <CheckCircle2 className="size-3.5" />
              {t('sync.status.success', { defaultValue: 'Data is synced.' })}
            </p>
          )}
        </section>

        {pendingConflicts.length > 0 && (
          <section className="rounded-lg border border-destructive/40 bg-background p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-destructive">
                  {t('sync.conflicts.title', { defaultValue: 'Conflicts' })}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {t('sync.conflicts.subtitle', {
                    defaultValue: 'Choose which side should win for each record.'
                  })}
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => void handleResolveConflicts()}
                disabled={!!runningMode}
              >
                {runningMode && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                {t('sync.conflicts.apply', { defaultValue: 'Apply choices' })}
              </Button>
            </div>
            <div className="space-y-3">
              {pendingConflicts.map((conflict) => (
                <div key={conflict.id} className="rounded-md border border-border/70 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{summarizeConflict(conflict)}</p>
                      <p className="text-xs text-muted-foreground">{conflict.kind}</p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant={
                          choiceByConflictId[conflict.id] === 'local' ? 'default' : 'outline'
                        }
                        onClick={() =>
                          setChoiceByConflictId((current) => ({
                            ...current,
                            [conflict.id]: 'local'
                          }))
                        }
                      >
                        {t('sync.conflicts.local', { defaultValue: 'Local' })}
                      </Button>
                      <Button
                        size="sm"
                        variant={
                          choiceByConflictId[conflict.id] === 'remote' ? 'default' : 'outline'
                        }
                        onClick={() =>
                          setChoiceByConflictId((current) => ({
                            ...current,
                            [conflict.id]: 'remote'
                          }))
                        }
                      >
                        {t('sync.conflicts.remote', { defaultValue: 'Remote' })}
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
