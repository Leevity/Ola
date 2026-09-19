import { LOCAL_PERSONAL_WORKSPACE } from '@renderer/lib/workspace-context'
import { useMemo } from 'react'
import { toast } from 'sonner'
import { switchWorkspace } from '@renderer/lib/switch-workspace'
import { Cloud, ExternalLink, LogIn, RefreshCw, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
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
  const startBrowserLogin = useRemoteAccountStore((state) => state.startBrowserLogin)
  const syncWorkspaces = useRemoteAccountStore((state) => state.syncWorkspaces)
  const workspaceSyncState = useRemoteAccountStore((state) => state.workspaceSyncState)
  const logout = useRemoteAccountStore((state) => state.logout)
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const olaWorkspaces = useWorkspaceStore((state) => state.olaWorkspaces)
  const workspaces = useMemo(() => [LOCAL_PERSONAL_WORKSPACE, ...olaWorkspaces], [olaWorkspaces])
  const resourcesByWorkspace = useWorkspaceStore((state) => state.resourcesByWorkspace)

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
            <Button size="sm" onClick={() => void startBrowserLogin()}>
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
                  void switchWorkspace(workspace.id).then((switched) => {
                    if (!switched) toast.error(t('layout:sidebar.workspaceBusy'))
                  })
                }}
                className={`flex w-full items-center justify-between rounded-xl border p-3 text-left transition-colors ${
                  selected
                    ? 'border-primary bg-primary/5'
                    : 'border-border/60 bg-muted/10 hover:bg-muted/30'
                }`}
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {workspace.kind === 'ola-team' ? (
                      <Users className="size-4" />
                    ) : (
                      <Cloud className="size-4" />
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
                <span className="text-xs text-muted-foreground">
                  {workspace.kind === 'local-personal'
                    ? t('architecture.pages.olaAccount.spaces.localModels')
                    : t('architecture.pages.olaAccount.spaces.resourceCount', {
                        count: resourceCount
                      })}
                </span>
              </button>
            )
          })}
        </div>
      </SettingsPanelSection>
      {account && workspaceSyncState === 'unavailable' && (
        <SettingsInfoNotice>
          {t('architecture.pages.olaAccount.syncUnavailable')}
        </SettingsInfoNotice>
      )}
      <SettingsSectionCard
        title={t('architecture.pages.olaAccount.resources.title')}
        description={t('architecture.pages.olaAccount.resources.description')}
        action={
          account ? (
            <Button
              variant="outline"
              size="sm"
              disabled={workspaceSyncState === 'syncing'}
              onClick={() => void syncWorkspaces().catch(() => undefined)}
            >
              <RefreshCw className="mr-1.5 size-3.5" />
              {t('architecture.pages.olaAccount.resources.refresh')}
            </Button>
          ) : undefined
        }
      >
        {lastSyncedAt && (
          <p className="mb-3 text-xs text-muted-foreground">
            {t('architecture.pages.olaAccount.lastSynced', {
              time: new Date(lastSyncedAt).toLocaleString()
            })}
          </p>
        )}
        {resourcesByWorkspace[activeWorkspaceId]?.length ? (
          <div className="space-y-2">
            {resourcesByWorkspace[activeWorkspaceId].map((resource) => (
              <div
                key={resource.id}
                className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2"
              >
                <span className="min-w-0">
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
                <span className="text-xs text-muted-foreground">
                  {resource.enabled
                    ? t('architecture.pages.olaAccount.resources.available')
                    : t('architecture.pages.olaAccount.resources.unavailable')}
                </span>
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
