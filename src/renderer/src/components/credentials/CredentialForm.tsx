import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useCredentialsStore } from '@renderer/stores/credentials-store'
import { VerificationResultCard } from './VerificationResultCard'
import type { VerificationResult } from '../../../../shared/credentials'

const DOMAIN_REGEX =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i

export interface CredentialFormProps {
  /** When set, the form enters edit mode for this credential. */
  editingId?: string | null
  editingDomain?: string
  editingUsername?: string
  editingNotes?: string
  /** Called when the user cancels editing. */
  onCancelEdit?: () => void
}

export function CredentialForm({
  editingId,
  editingDomain,
  editingUsername,
  editingNotes,
  onCancelEdit
}: CredentialFormProps = {}): React.JSX.Element {
  const { t } = useTranslation('credentials')
  const add = useCredentialsStore((s) => s.add)
  const update = useCredentialsStore((s) => s.update)
  const verifyVisually = useCredentialsStore((s) => s.verifyVisually)
  const [domain, setDomain] = useState(editingDomain ?? '')
  const [username, setUsername] = useState(editingUsername ?? '')
  const [password, setPassword] = useState('')
  const [notes, setNotes] = useState(editingNotes ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [lastResult, setLastResult] = useState<VerificationResult | null>(null)

  const isEditing = Boolean(editingId)

  useEffect(() => {
    setDomain(editingDomain ?? '')
    setUsername(editingUsername ?? '')
    setNotes(editingNotes ?? '')
    setPassword('')
    setLastResult(null)
  }, [editingDomain, editingId, editingNotes, editingUsername])

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const d = domain.trim()
    if (!d) {
      toast.error(t('errors.domainRequired'))
      return
    }
    if (!DOMAIN_REGEX.test(d)) {
      toast.error(t('errors.invalidDomain'))
      return
    }
    if (!username.trim()) {
      toast.error(t('errors.usernameRequired'))
      return
    }
    if (!isEditing && !password) {
      toast.error(t('errors.passwordRequired'))
      return
    }
    setSubmitting(true)
    setLastResult(null)
    try {
      if (isEditing && editingId) {
        // Edit mode: update existing credential.
        const updatePayload: { id: string; username?: string; password?: string; notes?: string } =
          {
            id: editingId,
            username: username.trim(),
            notes: notes.trim()
          }
        if (password) updatePayload.password = password
        const res = await update(updatePayload)
        setPassword('')
        if (res.error) {
          toast.error(t('add.error', { error: res.error }))
          return
        }
        toast.success(t('edit.success'))
        onCancelEdit?.()
      } else {
        // Add mode: create new credential.
        const res = await add({
          domain: d,
          username: username.trim(),
          password,
          notes: notes.trim()
        })
        setPassword('')
        if (res.error) {
          toast.error(t('add.error', { error: res.error }))
          return
        }
        const verification = res.ref ? await verifyVisually(res.ref.id, null) : res.verification
        if (verification) {
          setLastResult(verification)
          toast.success(
            t('add.success', {
              status:
                verification.status === 'pass'
                  ? t('status.pass')
                  : verification.status === 'challenge'
                    ? t('status.challenge')
                    : verification.status === 'fail'
                      ? t('status.fail')
                      : t('status.unknown')
            })
          )
        } else {
          toast.success(t('add.success', { status: t('status.unknown') }))
        }
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-md border border-border/60 bg-background p-4"
    >
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">
            {isEditing ? t('edit.title', { domain: editingDomain ?? domain }) : t('add.title')}
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {isEditing ? t('edit.help') : t('add.passwordHelp')}
          </p>
        </div>
        {isEditing ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-[11px]"
            onClick={onCancelEdit}
          >
            {t('edit.cancel')}
          </Button>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="cred-domain" className="text-xs">
            {t('add.domain')}
          </label>
          <Input
            id="cred-domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="github.com"
            autoComplete="off"
            className="h-8 text-xs"
            disabled={submitting || isEditing}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="cred-username" className="text-xs">
            {t('add.username')}
          </label>
          <Input
            id="cred-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="you@example.com"
            autoComplete="off"
            className="h-8 text-xs"
            disabled={submitting}
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <label htmlFor="cred-password" className="text-xs">
            {t('add.password')}
          </label>
          <Input
            id="cred-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            className="h-8 text-xs"
            disabled={submitting}
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <label htmlFor="cred-notes" className="text-xs">
            {t('add.notes')}
          </label>
          <Input
            id="cred-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            autoComplete="off"
            className="h-8 text-xs"
            disabled={submitting}
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <Button type="submit" size="sm" className="h-7 text-xs" disabled={submitting}>
          {submitting ? t('add.submitting') : isEditing ? t('edit.submit') : t('add.submit')}
        </Button>
        {lastResult && (
          <div className="min-w-0 flex-1">
            <VerificationResultCard result={lastResult} />
          </div>
        )}
      </div>
    </form>
  )
}
