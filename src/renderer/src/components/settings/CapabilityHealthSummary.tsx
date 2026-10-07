import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CircleAlert,
  CircleHelp,
  Download,
  Plug,
  Puzzle,
  Radio,
  RefreshCw,
  Sparkles,
  Wrench
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { buildCapabilityDiagnosticSnapshot } from '@renderer/lib/capability-diagnostics'
import { useChannelStore } from '@renderer/stores/channel-store'
import { useMcpStore } from '@renderer/stores/mcp-store'
import { useProviderHealthStore } from '@renderer/stores/provider-health-store'
import { useSkillsStore } from '@renderer/stores/skills-store'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useExtensionStore } from '@renderer/stores/extension-store'
import { useAppPluginStore, resolvePluginsForProject } from '@renderer/stores/app-plugin-store'
import { APP_PLUGIN_DESCRIPTORS, IMAGE_PLUGIN_ID } from '@renderer/lib/app-plugin/types'
import { useChatStore } from '@renderer/stores/chat-store'
import { useProviderStore } from '@renderer/stores/provider-store'

type HealthTone = 'healthy' | 'attention' | 'unknown' | 'inventory'
const VISIBLE_BUILTIN_PLUGIN_DESCRIPTORS = APP_PLUGIN_DESCRIPTORS.filter(
  (descriptor) => !descriptor.hidden
)

function HealthRow({
  icon: Icon,
  title,
  detail,
  tone,
  onOpenSettings
}: {
  icon: typeof Plug
  title: string
  detail: string
  tone: HealthTone
  onOpenSettings: () => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const badgeVariant = tone === 'healthy' ? 'secondary' : 'outline'
  const toneClass =
    tone === 'attention'
      ? 'text-amber-700 dark:text-amber-400'
      : tone === 'unknown'
        ? 'text-muted-foreground'
        : 'text-foreground'

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-background/60 p-3">
      <Icon className={`size-4 shrink-0 ${toneClass}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 break-words text-[0.8125rem] text-muted-foreground">{detail}</p>
      </div>
      <Badge variant={badgeVariant} className="shrink-0 text-xs">
        {t(`capabilityCenter.healthTone.${tone}`)}
      </Badge>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="shrink-0 text-[0.8125rem]"
        onClick={onOpenSettings}
      >
        {t('capabilityCenter.openSettings')}
      </Button>
    </div>
  )
}

export function CapabilityHealthSummary(): React.JSX.Element {
  const { t, i18n } = useTranslation('settings')
  const [refreshing, setRefreshing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const setSettingsTab = useUIStore((state) => state.setSettingsTab)
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const activeProjectId = useChatStore((state) => state.activeProjectId)
  const builtinPluginsHydrated = useAppPluginStore((state) => state.hydrated)
  const pluginsByProject = useAppPluginStore((state) => state.pluginsByProject)
  const builtinPlugins = useMemo(
    () => resolvePluginsForProject(pluginsByProject, activeProjectId),
    [activeProjectId, pluginsByProject]
  )
  const modelProviders = useProviderStore((state) => state.providers)
  const activeImageProviderId = useProviderStore((state) => state.activeImageProviderId)
  const activeImageModelId = useProviderStore((state) => state.activeImageModelId)
  const visibleBuiltinPlugins = useMemo(
    () =>
      builtinPlugins.filter((plugin) =>
        VISIBLE_BUILTIN_PLUGIN_DESCRIPTORS.some((descriptor) => descriptor.id === plugin.id)
      ),
    [builtinPlugins]
  )
  const enabledBuiltinPlugins = visibleBuiltinPlugins.filter((plugin) => plugin.enabled)
  const imagePlugin = visibleBuiltinPlugins.find((plugin) => plugin.id === IMAGE_PLUGIN_ID)
  const imageProviderId = imagePlugin?.useGlobalModel
    ? activeImageProviderId
    : imagePlugin?.providerId
  const imageModelId = imagePlugin?.useGlobalModel ? activeImageModelId : imagePlugin?.modelId
  const selectedImageProvider = modelProviders.find(
    (provider) => provider.id === imageProviderId && provider.enabled
  )
  const imageModelConfigured = Boolean(
    imagePlugin?.enabled &&
    selectedImageProvider?.models.some(
      (model) =>
        model.id === imageModelId && model.enabled && (model.category ?? 'chat') === 'image'
    )
  )
  const builtinPluginsNeedingSetup = imagePlugin?.enabled && !imageModelConfigured ? 1 : 0
  const providers = useProviderHealthStore((state) => state.providers)
  const providersLoadedAt = useProviderHealthStore((state) => state.loadedAt)
  const providerError = useProviderHealthStore((state) => state.loadError)
  const loadProviderHealth = useProviderHealthStore((state) => state.load)
  const skills = useSkillsStore((state) => state.skills)
  const skillsLoaded = useSkillsStore((state) => state.loaded)
  const skillsError = useSkillsStore((state) => state.loadError)
  const loadSkills = useSkillsStore((state) => state.loadSkills)
  const extensions = useExtensionStore((state) => state.extensions)
  const extensionsLoaded = useExtensionStore((state) => state.loaded)
  const extensionsError = useExtensionStore((state) => state.loadError)
  const loadExtensions = useExtensionStore((state) => state.loadExtensions)
  const servers = useMcpStore((state) => state.servers)
  const serverStatuses = useMcpStore((state) => state.serverStatuses)
  const serversLoaded = useMcpStore((state) => state.serversLoaded)
  const serversError = useMcpStore((state) => state.serversLoadError)
  const serverStatusCheckedAt = useMcpStore((state) => state.serverStatusCheckedAt)
  const serverStatusCheckError = useMcpStore((state) => state.serverStatusCheckError)
  const loadServers = useMcpStore((state) => state.loadServers)
  const refreshAllServers = useMcpStore((state) => state.refreshAllServers)
  const channels = useChannelStore((state) => state.channels)
  const channelStatuses = useChannelStore((state) => state.channelStatuses)
  const channelStatusCheckErrors = useChannelStore((state) => state.channelStatusCheckErrors)
  const channelStatusCheckedAt = useChannelStore((state) => state.channelStatusCheckedAt)
  const channelsLoaded = useChannelStore((state) => state.channelsLoaded)
  const channelsError = useChannelStore((state) => state.channelsLoadError)
  const loadChannels = useChannelStore((state) => state.loadChannels)
  const refreshChannelStatus = useChannelStore((state) => state.refreshChannelStatus)

  const refreshAll = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      await Promise.all([
        loadProviderHealth(),
        loadSkills(),
        loadExtensions(),
        loadServers(),
        loadChannels()
      ])
      if (workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) return
      const currentChannels = useChannelStore
        .getState()
        .channels.filter(
          (channel) => channel.enabled && (channel.workspaceId ?? 'local-personal') === workspaceId
        )
      await Promise.all([
        refreshAllServers(),
        ...currentChannels.map((channel) => refreshChannelStatus(channel.id))
      ])
      if (workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) return
      if (
        useProviderHealthStore.getState().loadError ||
        useSkillsStore.getState().loadError ||
        useExtensionStore.getState().loadError ||
        useMcpStore.getState().serversLoadError ||
        useMcpStore.getState().serverStatusCheckError ||
        useChannelStore.getState().channelsLoadError ||
        currentChannels.some(
          (channel) => useChannelStore.getState().channelStatusCheckErrors[channel.id]
        )
      )
        toast.error(t('capabilityCenter.refreshFailed'))
    } catch {
      if (workspaceId === useWorkspaceStore.getState().activeWorkspaceId)
        toast.error(t('capabilityCenter.refreshFailed'))
    } finally {
      setRefreshing(false)
    }
  }, [
    loadChannels,
    loadExtensions,
    loadProviderHealth,
    loadServers,
    loadSkills,
    refreshAllServers,
    refreshChannelStatus,
    workspaceId,
    t
  ])

  const exportDiagnostics = async (): Promise<void> => {
    setExporting(true)
    try {
      const selected = (await ipcClient.invoke(IPC.FS_SELECT_SAVE_FILE, {
        defaultPath: 'ola-capability-diagnostics.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })) as { path?: string; canceled?: boolean }
      if (!selected.path || selected.canceled) return

      const providerState = useProviderHealthStore.getState()
      const skillState = useSkillsStore.getState()
      const mcpState = useMcpStore.getState()
      const channelState = useChannelStore.getState()
      const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId
      const snapshot = buildCapabilityDiagnosticSnapshot({
        generatedAt: new Date(),
        locale: i18n.language,
        providerHealth: {
          loaded: providerState.loadedAt !== null,
          failed: providerState.loadError !== null,
          providers: providerState.providers
        },
        skills: {
          loaded: skillState.loaded,
          failed: skillState.loadError !== null,
          installedCount: skillState.skills.length
        },
        builtinPlugins: {
          loaded: useAppPluginStore.getState().hydrated,
          total: VISIBLE_BUILTIN_PLUGIN_DESCRIPTORS.length,
          enabled: visibleBuiltinPlugins.filter((plugin) => plugin.enabled).length,
          needsSetup: builtinPluginsNeedingSetup
        },
        extensions: {
          loaded: useExtensionStore.getState().loaded,
          failed: useExtensionStore.getState().loadError !== null,
          items: useExtensionStore.getState().extensions
        },
        mcp: {
          loaded: mcpState.serversLoaded,
          failed: mcpState.serversLoadError !== null,
          statusChecked: mcpState.serverStatusCheckedAt !== null,
          statusCheckFailed: mcpState.serverStatusCheckError !== null,
          servers: mcpState.servers,
          statuses: mcpState.serverStatuses
        },
        channels: {
          loaded: channelState.channelsLoaded,
          failed: channelState.channelsLoadError !== null,
          statusChecked: channelState.channelStatusCheckedAt !== null,
          statusCheckFailedCount: channelState.channels.filter(
            (channel) =>
              (channel.workspaceId ?? 'local-personal') === activeWorkspaceId &&
              channelState.channelStatusCheckErrors[channel.id]
          ).length,
          items: channelState.channels.filter(
            (channel) => (channel.workspaceId ?? 'local-personal') === activeWorkspaceId
          ),
          statuses: channelState.channelStatuses
        }
      })
      const writeResult = (await ipcClient.invoke(IPC.FS_WRITE_FILE, {
        path: selected.path,
        content: `${JSON.stringify(snapshot, null, 2)}\n`
      })) as { success?: boolean; error?: string }
      if (!writeResult.success) throw new Error(writeResult.error ?? 'write_failed')
      toast.success(t('capabilityCenter.diagnostics.exportSuccess'))
    } catch {
      toast.error(t('capabilityCenter.diagnostics.exportFailed'))
    } finally {
      setExporting(false)
    }
  }

  useEffect(() => {
    void Promise.all([
      loadProviderHealth(),
      loadSkills(),
      loadExtensions(),
      loadServers(),
      loadChannels()
    ])
  }, [loadChannels, loadExtensions, loadProviderHealth, loadServers, loadSkills, workspaceId])

  const enabledServers = servers.filter((server) => server.enabled)
  const connectedServers = enabledServers.filter(
    (server) => serverStatuses[server.id] === 'connected'
  )
  const failedServers = enabledServers.filter((server) => serverStatuses[server.id] === 'error')
  const disconnectedServers = enabledServers.filter(
    (server) => serverStatuses[server.id] === 'disconnected'
  )
  const connectingServers = enabledServers.filter(
    (server) => serverStatuses[server.id] === 'connecting'
  )
  const enabledChannels = channels.filter((channel) => channel.enabled)
  const activeWorkspaceChannels = enabledChannels.filter(
    (channel) => (channel.workspaceId ?? 'local-personal') === workspaceId
  )
  const runningChannels = activeWorkspaceChannels.filter(
    (channel) => channelStatuses[channel.id] === 'running'
  )
  const failedChannels = activeWorkspaceChannels.filter(
    (channel) => channelStatuses[channel.id] === 'error'
  )
  const stoppedChannels = activeWorkspaceChannels.filter(
    (channel) => channelStatuses[channel.id] === 'stopped'
  )
  const failedChannelStatusChecks = activeWorkspaceChannels.filter(
    (channel) => channelStatusCheckErrors[channel.id]
  )
  const providerTone: HealthTone = providerError
    ? 'attention'
    : !providersLoadedAt
      ? 'unknown'
      : providers.some((provider) => provider.status !== 'healthy')
        ? 'attention'
        : providers.length > 0
          ? 'healthy'
          : 'unknown'

  const providerDetail = providerError
    ? t('capabilityCenter.healthDetail.loadFailed')
    : !providersLoadedAt
      ? t('capabilityCenter.healthDetail.notChecked')
      : providers.length === 0
        ? t('capabilityCenter.healthDetail.noProviderRequests')
        : t('capabilityCenter.healthDetail.providerCounts', {
            healthy: providers.filter((provider) => provider.status === 'healthy').length,
            total: providers.length,
            checkedAt: new Intl.DateTimeFormat(i18n.language, {
              hour: '2-digit',
              minute: '2-digit'
            }).format(providersLoadedAt)
          })

  const skillsTone: HealthTone = skillsError ? 'attention' : skillsLoaded ? 'inventory' : 'unknown'
  const skillsDetail = skillsError
    ? t('capabilityCenter.healthDetail.loadFailed')
    : skillsLoaded
      ? t('capabilityCenter.healthDetail.skillCount', { count: skills.length })
      : t('capabilityCenter.healthDetail.notChecked')
  const extensionsTone: HealthTone = extensionsError
    ? 'attention'
    : extensionsLoaded
      ? 'inventory'
      : 'unknown'
  const extensionsDetail = extensionsError
    ? t('capabilityCenter.healthDetail.loadFailed')
    : extensionsLoaded
      ? t('capabilityCenter.healthDetail.extensionCounts', {
          enabled: extensions.filter((extension) => extension.enabled).length,
          installed: extensions.length
        })
      : t('capabilityCenter.healthDetail.notChecked')
  const builtinPluginsTone: HealthTone = !builtinPluginsHydrated
    ? 'unknown'
    : builtinPluginsNeedingSetup > 0
      ? 'attention'
      : 'inventory'
  const builtinPluginsDetail = !builtinPluginsHydrated
    ? t('capabilityCenter.healthDetail.notChecked')
    : t('capabilityCenter.healthDetail.builtinPluginCounts', {
        enabled: enabledBuiltinPlugins.length,
        total: VISIBLE_BUILTIN_PLUGIN_DESCRIPTORS.length,
        needsSetup: builtinPluginsNeedingSetup
      })

  const mcpTone: HealthTone =
    serversError || serverStatusCheckError
      ? 'attention'
      : !serversLoaded || (enabledServers.length > 0 && !serverStatusCheckedAt)
        ? 'unknown'
        : failedServers.length > 0
          ? 'attention'
          : disconnectedServers.length > 0
            ? 'attention'
            : enabledServers.length > 0 && connectedServers.length === enabledServers.length
              ? 'healthy'
              : enabledServers.length === 0
                ? 'inventory'
                : 'unknown'
  const mcpDetail =
    serversError || serverStatusCheckError
      ? t('capabilityCenter.healthDetail.loadFailed')
      : !serversLoaded || (enabledServers.length > 0 && !serverStatusCheckedAt)
        ? t('capabilityCenter.healthDetail.notChecked')
        : enabledServers.length === 0
          ? t('capabilityCenter.healthDetail.noneEnabled')
          : t('capabilityCenter.healthDetail.mcpCounts', {
              connected: connectedServers.length,
              enabled: enabledServers.length,
              failed: failedServers.length,
              disconnected: disconnectedServers.length,
              connecting: connectingServers.length,
              checkedAt: new Intl.DateTimeFormat(i18n.language, {
                hour: '2-digit',
                minute: '2-digit'
              }).format(serverStatusCheckedAt ?? undefined)
            })

  const channelTone: HealthTone =
    channelsError || failedChannelStatusChecks.length > 0
      ? 'attention'
      : !channelsLoaded || (activeWorkspaceChannels.length > 0 && !channelStatusCheckedAt)
        ? 'unknown'
        : failedChannels.length > 0
          ? 'attention'
          : stoppedChannels.length > 0
            ? 'attention'
            : activeWorkspaceChannels.length > 0 &&
                runningChannels.length === activeWorkspaceChannels.length
              ? 'healthy'
              : activeWorkspaceChannels.length === 0
                ? 'inventory'
                : 'unknown'
  const channelDetail = channelsError
    ? t('capabilityCenter.healthDetail.loadFailed')
    : failedChannelStatusChecks.length > 0
      ? t('capabilityCenter.healthDetail.statusCheckFailed')
      : !channelsLoaded || (activeWorkspaceChannels.length > 0 && !channelStatusCheckedAt)
        ? t('capabilityCenter.healthDetail.notChecked')
        : activeWorkspaceChannels.length === 0
          ? t('capabilityCenter.healthDetail.noneEnabled')
          : t('capabilityCenter.healthDetail.channelCounts', {
              running: runningChannels.length,
              enabled: activeWorkspaceChannels.length,
              failed: failedChannels.length,
              stopped: stoppedChannels.length,
              checkedAt: new Intl.DateTimeFormat(i18n.language, {
                hour: '2-digit',
                minute: '2-digit'
              }).format(channelStatusCheckedAt ?? undefined)
            })

  return (
    <section className="rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="mb-3 flex flex-wrap items-start gap-2">
        {providerError ||
        skillsError ||
        extensionsError ||
        serversError ||
        serverStatusCheckError ||
        channelsError ||
        failedChannelStatusChecks.length > 0 ? (
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" />
        ) : (
          <CircleHelp className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <div className="min-w-0 basis-[calc(100%-1.5rem)] flex-1">
          <h2 className="text-sm font-medium">{t('capabilityCenter.healthTitle')}</h2>
          <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">
            {t('capabilityCenter.healthDescription')}
          </p>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={refreshing}
            aria-label={t('capabilityCenter.refreshHealth')}
            onClick={() => void refreshAll()}
          >
            <RefreshCw className={`mr-1.5 size-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {t('capabilityCenter.refreshHealth')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={exporting}
            aria-label={t('capabilityCenter.diagnostics.export')}
            onClick={() => void exportDiagnostics()}
          >
            <Download className={`mr-1.5 size-3.5 ${exporting ? 'animate-pulse' : ''}`} />
            {t('capabilityCenter.diagnostics.export')}
          </Button>
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <HealthRow
          icon={Wrench}
          title={t('capabilityCenter.health.providers')}
          detail={providerDetail}
          tone={providerTone}
          onOpenSettings={() => setSettingsTab('provider')}
        />
        <HealthRow
          icon={Sparkles}
          title={t('capabilityCenter.health.skills')}
          detail={skillsDetail}
          tone={skillsTone}
          onOpenSettings={() => setSettingsTab('skillsmarket')}
        />
        <HealthRow
          icon={Puzzle}
          title={t('capabilityCenter.health.extensions')}
          detail={extensionsDetail}
          tone={extensionsTone}
          onOpenSettings={() => setSettingsTab('extension')}
        />
        <HealthRow
          icon={Wrench}
          title={t('capabilityCenter.health.builtinPlugins')}
          detail={builtinPluginsDetail}
          tone={builtinPluginsTone}
          onOpenSettings={() => setSettingsTab('plugin')}
        />
        <HealthRow
          icon={Plug}
          title={t('capabilityCenter.health.mcp')}
          detail={mcpDetail}
          tone={mcpTone}
          onOpenSettings={() => setSettingsTab('mcp')}
        />
        <HealthRow
          icon={Radio}
          title={t('capabilityCenter.health.channels')}
          detail={channelDetail}
          tone={channelTone}
          onOpenSettings={() => setSettingsTab('channel')}
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {t('capabilityCenter.diagnostics.privacyHint')}
      </p>
    </section>
  )
}
