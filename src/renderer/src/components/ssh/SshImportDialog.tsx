import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, FileUp, FolderSync, KeyRound, ShieldCheck } from 'lucide-react'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { toast } from 'sonner'

type ImportSource = 'ola' | 'openssh'
type ImportAction = 'create' | 'skip' | 'replace' | 'duplicate'

interface ImportPreviewConnection {
  importId: string
  source: ImportSource
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey' | 'agent'
  groupName: string | null
  privateKeyPath: string | null
  proxyJump: string | null
  startupCommand: string | null
  defaultDirectory: string | null
  keepAliveInterval: number | null
  hasKnownHost: boolean
  needsPrivateKeyReview: boolean
  warnings: string[]
  conflictConnectionId: string | null
  conflictConnectionName: string | null
  defaultAction: ImportAction
}

interface ImportPreviewResult {
  source: ImportSource
  filePath: string
  connectionCount: number
  groups: string[]
  warnings: string[]
  connections: ImportPreviewConnection[]
}

interface SshImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: () => void
}

export function SshImportDialog({
  open,
  onOpenChange,
  onImported
}: SshImportDialogProps): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const [source, setSource] = useState<ImportSource>('ola')
  const [filePath, setFilePath] = useState('')
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null)
  const [actions, setActions] = useState<Record<string, ImportAction>>({})
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    if (!open) {
      setFilePath('')
      setPreview(null)
      setActions({})
      setLoading(false)
      setApplying(false)
      setSource('ola')
    }
  }, [open])

  const selectedCount = useMemo(() => {
    if (!preview) return 0
    return preview.connections.filter(
      (item) => (actions[item.importId] ?? item.defaultAction) !== 'skip'
    ).length
  }, [actions, preview])

  const handlePickFile = async (): Promise<void> => {
    const filters =
      source === 'ola'
        ? [{ name: 'JSON', extensions: ['json'] }]
        : [
            { name: 'SSH Config', extensions: ['config', 'txt'] },
            { name: 'All Files', extensions: ['*'] }
          ]
    const result = await ipcClient.invoke(IPC.FS_SELECT_FILE, { filters })
    if (!result || typeof result !== 'object' || (result as { canceled?: boolean }).canceled) return
    const path = (result as { path?: string }).path
    if (!path) return
    setFilePath(path)
    await loadPreview(source, path)
  }

  const loadPreview = async (nextSource: ImportSource, nextFilePath: string): Promise<void> => {
    setLoading(true)
    try {
      const result = (await ipcClient.invoke(IPC.SSH_IMPORT_PREVIEW, {
        source: nextSource,
        filePath: nextFilePath
      })) as ImportPreviewResult | { error?: string }
      if (result && typeof result === 'object' && 'error' in result) {
        toast.error(String(result.error ?? t('migration.previewFailed')))
        setPreview(null)
        setActions({})
        return
      }
      const nextPreview = result as ImportPreviewResult
      setPreview(nextPreview)
      setActions(
        nextPreview.connections.reduce<Record<string, ImportAction>>((acc, item) => {
          acc[item.importId] = item.defaultAction
          return acc
        }, {})
      )
    } finally {
      setLoading(false)
    }
  }

  const handleImport = async (): Promise<void> => {
    if (!preview) return
    setApplying(true)
    try {
      const result = (await ipcClient.invoke(IPC.SSH_IMPORT_APPLY, {
        source: preview.source,
        filePath: preview.filePath,
        decisions: preview.connections.map((item) => ({
          importId: item.importId,
          action: actions[item.importId] ?? item.defaultAction
        }))
      })) as
        | {
            imported: number
            replaced: number
            duplicated: number
            skipped: number
            warnings?: string[]
            error?: string
          }
        | { error?: string }

      if (result && typeof result === 'object' && 'error' in result) {
        toast.error(String(result.error ?? t('migration.importFailed')))
        return
      }

      const summary = result as {
        imported: number
        replaced: number
        duplicated: number
        skipped: number
        warnings?: string[]
      }
      toast.success(
        t('migration.importSuccessSummary', {
          imported: summary.imported,
          replaced: summary.replaced,
          duplicated: summary.duplicated,
          skipped: summary.skipped
        })
      )
      onImported()
      onOpenChange(false)
    } finally {
      setApplying(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-h-[85vh] flex-col gap-0 p-0 sm:max-w-5xl">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="text-sm">{t('migration.importTitle')}</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Select
            value={source}
            onValueChange={(value) => {
              const nextValue = value as ImportSource
              setSource(nextValue)
              setPreview(null)
              setActions({})
            }}
          >
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ola">{t('migration.sourceOla')}</SelectItem>
              <SelectItem value="openssh">{t('migration.sourceOpenSsh')}</SelectItem>
            </SelectContent>
          </Select>

          <div className="min-w-0 flex-1 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <span className="block truncate">{filePath || t('migration.noFileSelected')}</span>
          </div>

          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1 text-xs"
            onClick={() => void handlePickFile()}
          >
            <FileUp className="size-3.5" />
            {t('migration.chooseFile')}
          </Button>

          {filePath && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1 text-xs"
              onClick={() => void loadPreview(source, filePath)}
              disabled={loading}
            >
              <FolderSync className="size-3.5" />
              {t('migration.reloadPreview')}
            </Button>
          )}
        </div>

        <div className="flex-1 overflow-hidden px-4 py-3">
          {!preview ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border text-center">
              <FileUp className="size-8 text-muted-foreground/40" />
              <div>
                <p className="text-sm text-foreground">{t('migration.importEmptyTitle')}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('migration.importEmptyDesc')}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col gap-3 overflow-hidden">
              <div className="grid grid-cols-4 gap-2">
                <SummaryCard
                  label={t('migration.totalConnections')}
                  value={String(preview.connectionCount)}
                />
                <SummaryCard
                  label={t('migration.totalGroups')}
                  value={String(preview.groups.length)}
                />
                <SummaryCard
                  label={t('migration.selectedToImport')}
                  value={String(selectedCount)}
                />
                <SummaryCard
                  label={t('migration.conflictCount')}
                  value={String(
                    preview.connections.filter((item) => item.conflictConnectionId).length
                  )}
                />
              </div>

              {(preview.warnings.length > 0 ||
                preview.connections.some(
                  (item) => item.hasKnownHost || item.needsPrivateKeyReview
                )) && (
                <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5 font-medium text-primary">
                    <AlertTriangle className="size-3.5" />
                    {t('migration.previewNotes')}
                  </div>
                  <div className="mt-2 flex flex-col gap-1 text-muted-foreground">
                    {preview.warnings.map((warning, index) => (
                      <span key={`${warning}-${index}`}>{warning}</span>
                    ))}
                    {preview.connections.some((item) => item.hasKnownHost) && (
                      <span>{t('migration.knownHostsDetected')}</span>
                    )}
                    {preview.connections.some((item) => item.needsPrivateKeyReview) && (
                      <span>{t('migration.privateKeyReviewHint')}</span>
                    )}
                  </div>
                </div>
              )}

              <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border">
                <div className="min-w-[980px]">
                  <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_minmax(0,1.3fr)_minmax(0,1.4fr)_140px] border-b bg-muted/20 px-3 py-2 text-[11px] font-medium text-muted-foreground">
                    <span>{t('migration.columns.name')}</span>
                    <span>{t('migration.columns.address')}</span>
                    <span>{t('migration.columns.details')}</span>
                    <span>{t('migration.columns.conflict')}</span>
                    <span>{t('migration.columns.action')}</span>
                  </div>

                  {preview.connections.map((item) => {
                    const action = actions[item.importId] ?? item.defaultAction
                    return (
                      <div
                        key={item.importId}
                        className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_minmax(0,1.3fr)_minmax(0,1.4fr)_140px] gap-3 border-b px-3 py-3 text-xs last:border-b-0"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium text-foreground">{item.name}</div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <Badge variant="outline">
                              {item.source === 'ola'
                                ? t('migration.sourceOlaShort')
                                : t('migration.sourceOpenSshShort')}
                            </Badge>
                            <Badge variant="outline">{t(`migration.auth.${item.authType}`)}</Badge>
                            {item.groupName && <Badge variant="outline">{item.groupName}</Badge>}
                          </div>
                        </div>

                        <div className="min-w-0 text-muted-foreground">
                          <div className="truncate">
                            {item.username}@{item.host}:{item.port}
                          </div>
                          {item.proxyJump && (
                            <div className="mt-1 truncate">ProxyJump: {item.proxyJump}</div>
                          )}
                          {item.privateKeyPath && (
                            <div className="mt-1 truncate">{item.privateKeyPath}</div>
                          )}
                        </div>

                        <div className="min-w-0">
                          <div className="flex flex-wrap gap-1">
                            {item.hasKnownHost && (
                              <Badge variant="secondary" className="gap-1">
                                <ShieldCheck className="size-3" />
                                known_hosts
                              </Badge>
                            )}
                            {item.needsPrivateKeyReview && (
                              <Badge variant="secondary" className="gap-1">
                                <KeyRound className="size-3" />
                                {t('migration.privateKeyCheck')}
                              </Badge>
                            )}
                          </div>
                          {item.warnings.length > 0 && (
                            <div className="mt-1 space-y-1 text-[11px] text-primary/80">
                              {item.warnings.map((warning, index) => (
                                <div key={`${warning}-${index}`}>{warning}</div>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="min-w-0 text-muted-foreground">
                          {item.conflictConnectionId ? (
                            <>
                              <div className="font-medium text-foreground">
                                {t('migration.conflictDetected')}
                              </div>
                              <div className="mt-1 truncate">{item.conflictConnectionName}</div>
                              <div className="truncate">
                                {item.username}@{item.host}:{item.port}
                              </div>
                            </>
                          ) : (
                            <div className="font-medium text-primary">
                              {t('migration.noConflict')}
                            </div>
                          )}
                        </div>

                        <div>
                          {item.conflictConnectionId ? (
                            <Select
                              value={action}
                              onValueChange={(value) => {
                                setActions((prev) => ({
                                  ...prev,
                                  [item.importId]: value as ImportAction
                                }))
                              }}
                            >
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="skip">{t('migration.actions.skip')}</SelectItem>
                                <SelectItem value="replace">
                                  {t('migration.actions.replace')}
                                </SelectItem>
                                <SelectItem value="duplicate">
                                  {t('migration.actions.duplicate')}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          ) : (
                            <Badge variant="secondary">{t('migration.actions.create')}</Badge>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t px-4 py-3">
          <div className="text-xs text-muted-foreground">
            {preview ? t('migration.importFooterHint') : t('migration.importFooterIdle')}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => onOpenChange(false)}
            >
              {t('form.cancel')}
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={() => void handleImport()}
              disabled={!preview || loading || applying}
            >
              {applying ? t('migration.importing') : t('migration.startImport')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SummaryCard({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-muted/10 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold text-foreground">{value}</div>
    </div>
  )
}
