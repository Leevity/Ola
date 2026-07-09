import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  AlertTriangle,
  KeyRound,
  RefreshCw,
  FlaskConical,
  Maximize2,
  Minimize2,
  Globe
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Separator } from '@renderer/components/ui/separator'
import { useCredentialsStore } from '@renderer/stores/credentials-store'
import { useLoginRunStore } from '@renderer/stores/login-run-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { BrowserPanel } from '@renderer/components/layout/BrowserPanel'
import { findSiteProfileByDomain } from '@renderer/lib/credentials/site-profiles'
import { useUIStore } from '@renderer/stores/ui-store'
import { CredentialList } from './CredentialList'
import { CredentialForm } from './CredentialForm'
import { BuiltinSiteTemplates } from './BuiltinSiteTemplates'

export function CredentialsPanel(): React.JSX.Element {
  const { t } = useTranslation('credentials')
  const refresh = useCredentialsStore((s) => s.refresh)
  const remove = useCredentialsStore((s) => s.remove)
  const verifyVisually = useCredentialsStore((s) => s.verifyVisually)
  const loading = useCredentialsStore((s) => s.loading)
  const initialized = useCredentialsStore((s) => s.initialized)
  const vaultBackend = useCredentialsStore((s) => s.vaultBackend)
  const vaultReason = useCredentialsStore((s) => s.vaultReason)
  const [verifyingId, setVerifyingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [browserCollapsed, setBrowserCollapsed] = useState(false)
  const seedLoginRun = useLoginRunStore((s) => s.seedPending)
  const clearLoginRun = useLoginRunStore((s) => s.clear)
  const loginRun = useLoginRunStore((s) => s.run)
  const devMode = useSettingsStore((s) => s.devMode)
  const isDev = import.meta.env.DEV || devMode

  useEffect(() => {
    if (!initialized) void refresh()
  }, [initialized, refresh])

  const onVerify = async (id: string): Promise<void> => {
    setVerifyingId(id)
    try {
      const result = await verifyVisually(id, null)
      if (!result) return
      if (result.status === 'pass') toast.success(t('status.pass'))
      else if (result.status === 'challenge') toast.warning(t('status.challenge'))
      else toast.error(t('status.fail'))
    } finally {
      setVerifyingId(null)
    }
  }

  const onRemove = async (id: string): Promise<void> => {
    const ok = await confirm({
      title: t('list.remove'),
      variant: 'destructive'
    })
    if (!ok) return
    await remove(id)
  }

  // Pick a target URL for the right-side BrowserPanel. Priority:
  //   1) a running login run (open that domain)
  //   2) the first stored credential's domain
  //   3) site profile lookup for that domain
  //   4) fallback: https://<domain>
  const refs = useCredentialsStore((s) => s.refs)
  const handleOpenBrowser = (): void => {
    const candidateDomain = loginRun?.domain ?? refs[0]?.domain
    if (!candidateDomain) {
      toast.error(t('browser.noCredential'))
      return
    }
    const profile = findSiteProfileByDomain(candidateDomain)
    const url = profile?.loginUrl ?? `https://${candidateDomain}`
    useUIStore.getState().setBrowserUrl(url, null, null)
    toast.success(t('browser.opened', { url }))
  }

  return (
    <div
      className={`grid h-full min-h-[600px] gap-4 p-4 transition-all ${
        browserCollapsed
          ? 'grid-cols-1'
          : 'grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]'
      }`}
    >
      {/* Left column: list / form / templates */}
      <div className="flex min-h-0 flex-col overflow-hidden">
        <div className="flex shrink-0 items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <KeyRound className="size-4 text-primary" />
              <h2 className="text-lg font-semibold">{t('title')}</h2>
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              onClick={handleOpenBrowser}
              data-testid="open-browser-button"
              title={t('browser.openTitle')}
            >
              <Globe className="mr-1 size-3" />
              {t('browser.open')}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => void refresh()}
              disabled={loading}
              title="Refresh"
            >
              <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        <div
          className={`mt-3 flex shrink-0 items-start gap-2 rounded-md border px-3 py-2 text-xs ${
            vaultBackend === 'safe_storage'
              ? 'border-emerald-300/60 bg-emerald-50/40 text-emerald-900 dark:border-emerald-700/40 dark:bg-emerald-900/20 dark:text-emerald-100'
              : 'border-amber-300/60 bg-amber-50/40 text-amber-900 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-100'
          }`}
        >
          {vaultBackend === 'safe_storage' ? null : <AlertTriangle className="mt-0.5 size-3.5" />}
          <div>
            <div className="font-medium">
              {vaultBackend === 'safe_storage' ? t('vault.safeStorage') : t('vault.inMemory')}
            </div>
            {vaultBackend !== 'safe_storage' && vaultReason ? (
              <div className="mt-0.5 opacity-80">{vaultReason}</div>
            ) : null}
          </div>
        </div>

        <div className="mt-3 flex-1 min-h-0 space-y-4 overflow-y-auto pr-1">
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">{t('list.title')}</h3>
            <CredentialList
              verifyingId={verifyingId}
              onVerify={(id) => void onVerify(id)}
              onRemove={(id) => void onRemove(id)}
              onEdit={(id) => setEditingId(id)}
            />
          </section>

          <Separator />

          <section className="space-y-3">
            <CredentialForm
              editingId={editingId}
              editingDomain={refs.find((r) => r.id === editingId)?.domain}
              editingUsername={refs.find((r) => r.id === editingId)?.usernameHint}
              editingNotes={refs.find((r) => r.id === editingId)?.notes}
              onCancelEdit={() => setEditingId(null)}
            />
          </section>

          <Separator />

          <section className="space-y-3">
            <BuiltinSiteTemplates />
          </section>

          {isDev ? (
            <>
              <Separator />
              <section className="space-y-2 rounded-md border border-dashed border-amber-300/60 bg-amber-50/30 px-3 py-2 text-[11px] dark:border-amber-700/40 dark:bg-amber-900/10">
                <div className="flex items-center gap-1.5 text-amber-900 dark:text-amber-200">
                  <FlaskConical className="size-3.5" />
                  <span className="font-medium">{t('dev.title')}</span>
                </div>
                <p className="text-muted-foreground">{t('dev.description')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    onClick={() => {
                      seedLoginRun({
                        id: `dev-${Date.now()}`,
                        domain: 'github.com',
                        credentialId: 'dev-stub',
                        username: 'demo@github.com'
                      })
                      toast.info(t('dev.seeded'))
                    }}
                    data-testid="seed-login-run"
                  >
                    {t('dev.seed')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[11px]"
                    onClick={() => {
                      clearLoginRun()
                      toast.info(t('dev.cleared'))
                    }}
                  >
                    {t('dev.clear')}
                  </Button>
                </div>
              </section>
            </>
          ) : null}
        </div>
      </div>

      {/* Right column: embedded BrowserPanel */}
      <div className="flex min-h-0 min-w-0 max-w-full flex-col overflow-hidden rounded-md border border-border/60 bg-background">
        <div className="flex shrink-0 items-center justify-between border-b border-border/60 bg-muted/20 px-3 py-1.5 text-xs">
          <div className="flex items-center gap-2 font-medium text-foreground/80">
            <FlaskConical className="size-3.5 text-muted-foreground" />
            <span>{t('browser.title')}</span>
            {loginRun ? (
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">
                run active
              </span>
            ) : (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                idle
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => setBrowserCollapsed(!browserCollapsed)}
            title={browserCollapsed ? t('browser.expand') : t('browser.collapse')}
          >
            {browserCollapsed ? (
              <Maximize2 className="size-3.5" />
            ) : (
              <Minimize2 className="size-3.5" />
            )}
          </Button>
        </div>
        <div className="flex-1 overflow-hidden">
          <BrowserPanel />
        </div>
      </div>
    </div>
  )
}
