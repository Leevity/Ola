import { Trash2, ShieldCheck, Loader2, Globe2, Pencil } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { useCredentialsStore } from '@renderer/stores/credentials-store'
import { VerificationResultCard } from './VerificationResultCard'

interface Props {
  verifyingId: string | null
  onVerify: (id: string) => void
  onRemove: (id: string) => void
  onEdit?: (id: string) => void
}

function formatDate(ts: number | undefined): string {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ''
  }
}

export function CredentialList({
  verifyingId,
  onVerify,
  onRemove,
  onEdit
}: Props): React.JSX.Element {
  const { t } = useTranslation('credentials')
  const refs = useCredentialsStore((s) => s.refs)
  if (refs.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border/60 bg-muted/10 px-4 py-6 text-center text-xs text-muted-foreground">
        {t('list.empty')}
      </div>
    )
  }
  return (
    <div className="divide-y divide-border/40 overflow-hidden rounded-md border border-border/60 bg-background">
      {refs.map((ref) => {
        const verifying = verifyingId === ref.id
        return (
          <div
            key={ref.id}
            className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 items-start gap-3">
              <Globe2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {ref.domain}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {ref.usernameHint ? `· ${ref.usernameHint}` : ''}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {ref.lastVerifiedAt
                    ? t('list.lastVerified', { when: formatDate(ref.lastVerifiedAt) })
                    : t('list.neverVerified')}
                </div>
                <div className="mt-2 max-w-md">
                  <VerificationResultCard
                    result={
                      ref.lastVerificationStatus
                        ? {
                            status: ref.lastVerificationStatus,
                            domain: ref.domain,
                            durationMs: 0,
                            testedAt: ref.lastVerifiedAt ?? 0
                          }
                        : null
                    }
                    compact
                  />
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px]"
                onClick={() => onVerify(ref.id)}
                disabled={verifying}
              >
                {verifying ? (
                  <Loader2 className="mr-1 size-3 animate-spin" />
                ) : (
                  <ShieldCheck className="mr-1 size-3" />
                )}
                {verifying ? t('list.verifying') : t('list.verify')}
              </Button>
              {onEdit ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:text-foreground"
                  onClick={() => onEdit(ref.id)}
                  title={t('list.edit')}
                >
                  <Pencil className="size-3.5" />
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-destructive"
                onClick={() => onRemove(ref.id)}
                title={t('list.remove')}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
