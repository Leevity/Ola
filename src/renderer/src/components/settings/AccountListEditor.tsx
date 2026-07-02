import { useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronUp,
  Download,
  FileJson,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  XCircle
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import {
  clearAccountRateLimit,
  exportProviderAccounts,
  importOauthAccountsFromJson,
  refreshProviderOAuth,
  removeOauthAccount,
  reorderProviderAccounts,
  setActiveProviderAccount,
  startProviderOAuth,
  updateProviderAccountInfo
} from '@renderer/lib/auth/provider-auth'
import type { AIProvider, ProviderOAuthAccount } from '@renderer/lib/api/types'

interface Props {
  provider: AIProvider
}

type AccountStatus = 'active' | 'idle' | 'rate-limited' | 'expired'

function computeStatus(provider: AIProvider, account: ProviderOAuthAccount): AccountStatus {
  if (account.rateLimit && account.rateLimit.resetAt > Date.now()) return 'rate-limited'
  if (account.oauth.expiresAt && account.oauth.expiresAt < Date.now()) return 'expired'
  if (provider.activeAccountId === account.id) return 'active'
  return 'idle'
}

function formatRelative(ts?: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return `${Math.max(0, Math.floor(diff / 1000))}s`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return `${Math.floor(diff / 86_400_000)}d`
}

function formatResetAt(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function AccountListEditor({ provider }: Props): ReactElement {
  const { t } = useTranslation('settings')
  const accounts = provider.oauthAccounts ?? []

  const [pendingId, setPendingId] = useState<string | null>(null)
  const [addingAccount, setAddingAccount] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [editingEmailId, setEditingEmailId] = useState<string | null>(null)
  const [emailDraft, setEmailDraft] = useState('')

  const sorted = useMemo(() => accounts, [accounts])

  async function handleAddAccount(): Promise<void> {
    setAddingAccount(true)
    try {
      const controller = new AbortController()
      await startProviderOAuth(provider.id, controller.signal)
      toast.success(t('provider.accounts.toasts.addSuccess'))
    } catch (err) {
      toast.error(
        t('provider.accounts.toasts.addFailed', {
          error: err instanceof Error ? err.message : String(err)
        })
      )
    } finally {
      setAddingAccount(false)
    }
  }

  async function handleImportJson(rawText: string): Promise<void> {
    setImportBusy(true)
    try {
      const result = await importOauthAccountsFromJson(provider.id, rawText)
      const msg = t('provider.accounts.toasts.importResult', {
        imported: result.imported,
        skipped: result.skipped.length
      })
      if (result.skipped.length > 0) {
        toast.warning(msg, {
          description: result.skipped.map((s) => `#${s.index + 1}: ${s.reason}`).join(', ')
        })
      } else {
        toast.success(msg)
      }
      setImportOpen(false)
      setImportText('')
    } catch (err) {
      toast.error(
        t('provider.accounts.toasts.importFailed', {
          error: err instanceof Error ? err.message : String(err)
        })
      )
    } finally {
      setImportBusy(false)
    }
  }

  async function handleImportFromFile(): Promise<void> {
    try {
      const api = (
        window as unknown as {
          api?: {
            fs?: {
              selectFile?: (args: {
                filters?: Array<{ name: string; extensions: string[] }>
              }) => Promise<unknown>
            }
          }
        }
      ).api
      const selectFile = api?.fs?.selectFile
      if (!selectFile) {
        toast.error(t('provider.accounts.toasts.fileApiMissing'))
        return
      }
      const result = (await selectFile({
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })) as { path?: string; canceled?: boolean }
      if (!result || result.canceled || !result.path) return
      const readFile = (
        window as unknown as {
          api?: { fs?: { readFile?: (args: { path: string }) => Promise<{ content: string }> } }
        }
      ).api?.fs?.readFile
      if (!readFile) {
        toast.error(t('provider.accounts.toasts.fileApiMissing'))
        return
      }
      const content = await readFile({ path: result.path })
      await handleImportJson(content?.content ?? '')
    } catch (err) {
      toast.error(
        t('provider.accounts.toasts.importFailed', {
          error: err instanceof Error ? err.message : String(err)
        })
      )
    }
  }

  function handleExport(): void {
    try {
      const json = exportProviderAccounts(provider.id)
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        void navigator.clipboard.writeText(json)
        toast.success(t('provider.accounts.toasts.exportCopied'))
      } else {
        toast.info(json)
      }
    } catch (err) {
      toast.error(
        t('provider.accounts.toasts.exportFailed', {
          error: err instanceof Error ? err.message : String(err)
        })
      )
    }
  }

  async function handleRefresh(account: ProviderOAuthAccount): Promise<void> {
    setPendingId(account.id)
    try {
      await refreshProviderOAuth(provider.id, true, account.id)
      toast.success(t('provider.accounts.toasts.refreshSuccess'))
    } catch (err) {
      toast.error(
        t('provider.accounts.toasts.refreshFailed', {
          error: err instanceof Error ? err.message : String(err)
        })
      )
    } finally {
      setPendingId(null)
    }
  }

  async function handleRemove(account: ProviderOAuthAccount): Promise<void> {
    const ok = await confirm({
      title: t('provider.accounts.confirmRemove.title'),
      description: t('provider.accounts.confirmRemove.description', {
        email: account.email
      }),
      confirmLabel: t('provider.accounts.confirmRemove.confirm'),
      variant: 'destructive'
    })
    if (!ok) return
    removeOauthAccount(provider.id, account.id)
    toast.success(t('provider.accounts.toasts.removeSuccess'))
  }

  function handleSetActive(account: ProviderOAuthAccount): void {
    setActiveProviderAccount(provider.id, account.id)
  }

  function handleClearRateLimit(account: ProviderOAuthAccount): void {
    clearAccountRateLimit(provider.id, account.id)
  }

  function move(index: number, dir: -1 | 1): void {
    const next = [...sorted]
    const target = index + dir
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    reorderProviderAccounts(
      provider.id,
      next.map((a) => a.id)
    )
  }

  function beginEditEmail(account: ProviderOAuthAccount): void {
    setEditingEmailId(account.id)
    setEmailDraft(account.email)
  }

  function commitEmail(account: ProviderOAuthAccount): void {
    const trimmed = emailDraft.trim()
    if (trimmed && trimmed !== account.email) {
      updateProviderAccountInfo(provider.id, account.id, { email: trimmed })
    }
    setEditingEmailId(null)
    setEmailDraft('')
  }

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">
          {t('provider.accounts.title')}
          <span className="ml-2 text-xs text-muted-foreground">({accounts.length})</span>
        </h4>
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-[11px]"
            onClick={() => void handleAddAccount()}
            disabled={addingAccount}
          >
            {addingAccount ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Plus className="size-3" />
            )}
            {t('provider.accounts.addAccount')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-[11px]"
            onClick={() => setImportOpen(true)}
          >
            <FileJson className="size-3" />
            {t('provider.accounts.importJson')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-[11px]"
            onClick={() => void handleImportFromFile()}
          >
            <Upload className="size-3" />
            {t('provider.accounts.importFile')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-[11px]"
            onClick={handleExport}
            disabled={accounts.length === 0}
          >
            <Download className="size-3" />
            {t('provider.accounts.export')}
          </Button>
        </div>
      </div>

      {accounts.length === 0 ? (
        <p className="text-xs text-muted-foreground py-3 text-center">
          {t('provider.accounts.empty')}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {sorted.map((account, index) => {
            const status = computeStatus(provider, account)
            const isBusy = pendingId === account.id
            const isEditingEmail = editingEmailId === account.id
            return (
              <li
                key={account.id}
                className={`flex items-center gap-2 rounded border bg-background px-2 py-1.5 ${
                  status === 'active' ? 'ring-1 ring-primary/40' : ''
                }`}
              >
                <div className="flex flex-col">
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  >
                    <ChevronUp className="size-3" />
                  </button>
                  <button
                    type="button"
                    disabled={index === sorted.length - 1}
                    onClick={() => move(index, 1)}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  >
                    <ChevronDown className="size-3" />
                  </button>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {isEditingEmail ? (
                      <Input
                        value={emailDraft}
                        onChange={(e) => setEmailDraft(e.target.value)}
                        onBlur={() => commitEmail(account)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEmail(account)
                          if (e.key === 'Escape') setEditingEmailId(null)
                        }}
                        className="h-6 text-xs"
                        autoFocus
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => beginEditEmail(account)}
                        className="text-xs font-medium truncate text-left hover:underline"
                        title={account.email}
                      >
                        {account.email}
                      </button>
                    )}
                    <StatusChip status={status} account={account} />
                  </div>
                  <div className="text-[10px] text-muted-foreground flex items-center gap-2">
                    {account.lastUsedAt && (
                      <span>
                        {t('provider.accounts.lastUsed', {
                          time: formatRelative(account.lastUsedAt)
                        })}
                      </span>
                    )}
                    {account.oauth.accountId && (
                      <span className="font-mono truncate">{account.oauth.accountId}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-0.5">
                  {status !== 'active' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      title={t('provider.accounts.actions.setActive')}
                      onClick={() => handleSetActive(account)}
                    >
                      <ShieldCheck className="size-3" />
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0"
                    title={t('provider.accounts.actions.refresh')}
                    disabled={isBusy}
                    onClick={() => void handleRefresh(account)}
                  >
                    {isBusy ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3" />
                    )}
                  </Button>
                  {status === 'rate-limited' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      title={t('provider.accounts.actions.clearLimit')}
                      onClick={() => handleClearRateLimit(account)}
                    >
                      <XCircle className="size-3" />
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                    title={t('provider.accounts.actions.delete')}
                    onClick={() => void handleRemove(account)}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('provider.accounts.import.title')}</DialogTitle>
            <DialogDescription>{t('provider.accounts.import.description')}</DialogDescription>
          </DialogHeader>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            spellCheck={false}
            className="w-full h-60 font-mono text-xs border rounded-md p-2 bg-background"
            placeholder='[ { "email": "a@x.com", "access_token": "...", "refresh_token": "...", "expires_at": 1700000000000 } ]'
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setImportOpen(false)}>
              {t('provider.accounts.import.cancel')}
            </Button>
            <Button
              size="sm"
              disabled={importBusy || !importText.trim()}
              onClick={() => void handleImportJson(importText)}
            >
              {importBusy && <Loader2 className="size-3 animate-spin mr-1" />}
              {t('provider.accounts.import.confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function StatusChip({
  status,
  account
}: {
  status: AccountStatus
  account: ProviderOAuthAccount
}): ReactElement {
  const { t } = useTranslation('settings')
  const cls =
    status === 'active'
      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
      : status === 'rate-limited'
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
        : status === 'expired'
          ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
          : 'bg-muted text-muted-foreground'
  const label =
    status === 'active'
      ? t('provider.accounts.status.active')
      : status === 'rate-limited'
        ? t('provider.accounts.status.rateLimitedUntil', {
            time: account.rateLimit ? formatResetAt(account.rateLimit.resetAt) : ''
          })
        : status === 'expired'
          ? t('provider.accounts.status.expired')
          : t('provider.accounts.status.idle')
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${cls}`}>{label}</span>
}
