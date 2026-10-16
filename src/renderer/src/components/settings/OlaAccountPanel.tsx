import { LOCAL_PERSONAL_WORKSPACE } from '@renderer/lib/workspace-context'
import { useMemo } from 'react'
import { toast } from 'sonner'
import { switchWorkspace } from '@renderer/lib/switch-workspace'
import { Check, Cloud, ExternalLink, Loader2, LogIn, Monitor, RefreshCw, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { useUIStore } from '@renderer/stores/ui-store'
import { useRemoteAccountStore } from '@renderer/stores/remote-account-store'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'
import {
  SettingsEmptyState,
  SettingsField,
  SettingsInfoNotice,
  SettingsPageHeader,
  SettingsPanelSection,
  SettingsSectionCard,
  SETTINGS_PANEL_CLASS
} from './settings-primitives'

export function OlaAccountPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const account = useRemoteAccountStore((state) => state.account)
  const device = useRemoteAccountStore((state) => state.device)
  const lastSyncedAt = useWorkspaceStore((state) => state.lastSyncedAt)
  const apiBaseUrl = useRemoteAccountStore((state) => state.apiBaseUrl)
  const openAccountAuthPage = useUIStore((state) => state.openAccountAuthPage)
  const setSettingsTab = useUIStore((state) => state.setSettingsTab)
  const syncWorkspaces = useRemoteAccountStore((state) => state.syncWorkspaces)
  const workspaceSyncState = useRemoteAccountStore((state) => state.workspaceSyncState)
  const logout = useRemoteAccountStore((state) => state.logout)
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const olaWorkspaces = useWorkspaceStore((state) => state.olaWorkspaces)
  const workspaces = useMemo(() => [LOCAL_PERSONAL_WORKSPACE, ...olaWorkspaces], [olaWorkspaces])
  const resourcesByWorkspace = useWorkspaceStore((state) => state.resourcesByWorkspace)
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const isLocalWorkspace = activeWorkspace?.kind === 'local-personal'
  const activeWorkspaceName = isLocalWorkspace
    ? t('architecture.pages.olaAccount.spaces.localName')
    : activeWorkspace?.name

  const openAccountSite = (): void => {
    window.open(apiBaseUrl, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className={SETTINGS_PANEL_CLASS}>
      <SettingsPageHeader
        title={t('architecture.pages.olaAccount.title')}
        description={t('architecture.pages.olaAccount.description')}
        icon={Cloud}
      />
      <SettingsInfoNotice>
        {t('architecture.pages.olaAccount.localProviderNotice')}
      </SettingsInfoNotice>
      <SettingsSectionCard
        title={t('architecture.pages.olaAccount.connection.title')}
        description={t('architecture.pages.olaAccount.connection.description')}
        icon={Cloud}
        action={
          account ? (
            <Button variant="outline" size="sm" onClick={() => logout()}>
              {t('architecture.pages.olaAccount.connection.signOut')}
            </Button>
          ) : (
            <Button size="sm" onClick={openAccountAuthPage}>
              <LogIn className="mr-1.5 size-3.5" />
              {t('architecture.pages.olaAccount.connection.signIn')}
            </Button>
          )
        }
      >
        <SettingsField
          label={account?.displayName || t('architecture.pages.olaAccount.connection.notSignedIn')}
          description={
            account?.email || t('architecture.pages.olaAccount.connection.notSignedInDescription')
          }
        >
          <Button variant="ghost" size="sm" onClick={openAccountSite}>
            {t('architecture.pages.olaAccount.connection.manage')}
            <ExternalLink className="ml-1.5 size-3.5" />
          </Button>
        </SettingsField>
        {device && (
          <p className="px-4 pb-3 text-xs text-muted-foreground">
            {t('architecture.pages.olaAccount.deviceRegistered', { name: device.deviceName })}
          </p>
        )}
      </SettingsSectionCard>
      <SettingsPanelSection
        title={t('architecture.pages.olaAccount.spaces.title')}
        description={t('architecture.pages.olaAccount.spaces.description')}
      >
        <div className="space-y-2">
          {workspaces.map((workspace) => {
            const selected = workspace.id === activeWorkspaceId
            const resourceCount =
              resourcesByWorkspace[workspace.id]?.filter((item) => item.enabled).length ?? 0
            return (
              <button
                key={workspace.id}
                type="button"
                onClick={() => {
                  void switchWorkspace(workspace.id)
                    .then((switched) => {
                      if (!switched) toast.error(t('layout:sidebar.workspaceBusy'))
                    })
                    .catch(() =>
                      toast.error(t('architecture.pages.olaAccount.spaces.switchFailed'))
                    )
                }}
                aria-pressed={selected}
                className={`flex w-full min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  selected
                    ? 'border-primary bg-primary/5'
                    : 'border-border/60 bg-muted/10 hover:bg-muted/30'
                }`}
              >
                <span className="min-w-0 flex-1 basis-40">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {workspace.kind === 'ola-team' ? (
                      <Users className="size-4 shrink-0" />
                    ) : workspace.kind === 'local-personal' ? (
                      <Monitor className="size-4 shrink-0" />
                    ) : (
                      <Cloud className="size-4 shrink-0" />
                    )}
                    <span className="truncate">
                      {workspace.kind === 'local-personal'
                        ? t('architecture.pages.olaAccount.spaces.localName')
                        : workspace.name}
                    </span>
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {workspace.kind === 'local-personal'
                      ? t('architecture.pages.olaAccount.spaces.local')
                      : workspace.kind === 'ola-team'
                        ? t('architecture.pages.olaAccount.spaces.team')
                        : t('architecture.pages.olaAccount.spaces.personal')}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {selected && (
                    <Badge variant="secondary">
                      <Check className="mr-1 size-3" aria-hidden="true" />
                      {t('architecture.pages.olaAccount.spaces.current')}
                    </Badge>
                  )}
                  {workspace.kind === 'local-personal'
                    ? t('architecture.pages.olaAccount.spaces.localModels')
                    : workspaceSyncState === 'syncing'
                      ? t('architecture.pages.olaAccount.resources.loading')
                      : workspaceSyncState === 'unavailable'
                        ? t('architecture.pages.olaAccount.resources.notVerified')
                        : t('architecture.pages.olaAccount.spaces.resourceCount', {
                            count: resourceCount
                          })}
                </span>
              </button>
            )
          })}
        </div>
      </SettingsPanelSection>
      {account && isLocalWorkspace && workspaceSyncState === 'unavailable' && (
        <div role="status">
          <SettingsInfoNotice>
            {t('architecture.pages.olaAccount.syncUnavailable')}
          </SettingsInfoNotice>
        </div>
      )}
      <SettingsSectionCard
        title={t('architecture.pages.olaAccount.resources.title')}
        description={t('architecture.pages.olaAccount.resources.workspace', {
          name: activeWorkspaceName
        })}
        action={
          account ? (
            <Button
              variant="outline"
              size="sm"
              disabled={workspaceSyncState === 'syncing'}
              onClick={() => void syncWorkspaces().catch(() => undefined)}
            >
              <RefreshCw
                className={`mr-1.5 size-3.5 ${workspaceSyncState === 'syncing' ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              {t(
                workspaceSyncState === 'syncing'
                  ? 'architecture.pages.olaAccount.resources.loading'
                  : 'architecture.pages.olaAccount.resources.refresh'
              )}
            </Button>
          ) : undefined
        }
      >
        {account && lastSyncedAt && workspaceSyncState === 'idle' && !isLocalWorkspace && (
          <p className="mb-3 text-xs text-muted-foreground">
            {t('architecture.pages.olaAccount.lastSynced', {
              time: new Date(lastSyncedAt).toLocaleString()
            })}
          </p>
        )}
        {isLocalWorkspace ? (
          <div className="space-y-3">
            <SettingsInfoNotice>
              {t('architecture.pages.olaAccount.resources.localDescription')}
            </SettingsInfoNotice>
            <Button variant="outline" size="sm" onClick={() => setSettingsTab('provider')}>
              {t('architecture.pages.olaAccount.resources.localAction')}
            </Button>
          </div>
        ) : account && workspaceSyncState === 'syncing' ? (
          <div role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {t('architecture.pages.olaAccount.resources.loading')}
          </div>
        ) : account && workspaceSyncState === 'unavailable' ? (
          <div role="status">
            <SettingsInfoNotice>
              {t('architecture.pages.olaAccount.syncUnavailable')}
            </SettingsInfoNotice>
          </div>
        ) : resourcesByWorkspace[activeWorkspaceId]?.length ? (
          <div className="space-y-2">
            {resourcesByWorkspace[activeWorkspaceId].map((resource) => (
              <div
                key={resource.id}
                className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2"
              >
                <span className="min-w-0 flex-1 basis-40">
                  <span className="block truncate text-sm font-medium">
                    {resource.displayName || resource.model}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {resource.providerName}
                    {resource.isDefault && ` · ${t('architecture.pages.olaAccount.defaultModel')}`}
                    {resource.supportsVision && ` · ${t('layout:topbar.vision')}`}
                    {resource.supportsFunctionCall && ` · ${t('layout:topbar.tools')}`}
                  </span>
                </span>
                <Badge variant={resource.enabled ? 'secondary' : 'outline'}>
                  {resource.enabled
                    ? t('architecture.pages.olaAccount.resources.available')
                    : t('architecture.pages.olaAccount.resources.unavailable')}
                </Badge>
              </div>
            ))}
          </div>
        ) : (
          <SettingsEmptyState>
            {t('architecture.pages.olaAccount.resources.empty')}
          </SettingsEmptyState>
        )}
      </SettingsSectionCard>
    </div>
  )
}
