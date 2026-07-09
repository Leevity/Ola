import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Loader2, Sparkles, Check } from 'lucide-react'
import { useCredentialsStore } from '@renderer/stores/credentials-store'
import { SHARED_BUILTIN_SITE_TEMPLATES } from '../../../../shared/site-profiles-shared'
import { VerificationResultCard } from './VerificationResultCard'
import type { VerificationResult } from '../../../../shared/credentials'

export function BuiltinSiteTemplates(): React.JSX.Element {
  const { t } = useTranslation('credentials')
  const refs = useCredentialsStore((s) => s.refs)
  const enable = useCredentialsStore((s) => s.enableTemplate)
  const verifyVisually = useCredentialsStore((s) => s.verifyVisually)

  const [activeId, setActiveId] = useState<string | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [activeResult, setActiveResult] = useState<VerificationResult | null>(null)
  const [verifyingId, setVerifyingId] = useState<string | null>(null)

  const enabledDomains = new Set(refs.map((r) => r.domain))

  const onEnable = async (): Promise<void> => {
    if (!activeId) return
    if (!username.trim()) {
      toast.error(t('errors.usernameRequired'))
      return
    }
    if (!password) {
      toast.error(t('errors.passwordRequired'))
      return
    }
    setSubmitting(true)
    setActiveResult(null)
    try {
      const res = await enable({
        templateId: activeId,
        username: username.trim(),
        password
      })
      if (res.error) {
        toast.error(t('add.error', { error: res.error }))
        return
      }
      const verification = res.ref ? await verifyVisually(res.ref.id, null) : res.verification
      if (verification) setActiveResult(verification)
      // Close on pass, keep open on challenge/fail so user can see result.
      if (verification?.status === 'pass') {
        setActiveId(null)
        setUsername('')
        setPassword('')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const onRevalidate = async (id: string): Promise<void> => {
    setVerifyingId(id)
    try {
      const result = await verifyVisually(id, null)
      if (result) {
        if (result.status === 'pass') toast.success(t('status.pass'))
        else if (result.status === 'challenge') toast.warning(t('status.challenge'))
        else toast.error(t('status.fail'))
      }
    } finally {
      setVerifyingId(null)
    }
  }

  const activeProfile = activeId
    ? (SHARED_BUILTIN_SITE_TEMPLATES.find((p) => p.id === activeId) ?? null)
    : null

  // Group by category for nicer presentation.
  const groups = new Map<string, typeof SHARED_BUILTIN_SITE_TEMPLATES>()
  for (const profile of SHARED_BUILTIN_SITE_TEMPLATES) {
    if (!profile.domain) continue // hide empty custom slots from the list
    const arr = groups.get(profile.category) ?? []
    arr.push(profile)
    groups.set(profile.category, arr)
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">{t('templates.title')}</h3>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{t('templates.subtitle')}</p>
      </div>
      <div className="space-y-4">
        {Array.from(groups.entries()).map(([category, items]) => (
          <div key={category} className="space-y-1.5">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80">
              {category}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {items.map((profile) => {
                const enabled = enabledDomains.has(profile.domain)
                return (
                  <div
                    key={profile.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium">{profile.displayName}</div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {profile.domain}
                      </div>
                    </div>
                    {enabled ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[10px]"
                        onClick={() => {
                          const ref = refs.find((r) => r.domain === profile.domain)
                          if (ref) void onRevalidate(ref.id)
                        }}
                        disabled={verifyingId !== null}
                      >
                        {verifyingId ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <>
                            <Check className="mr-1 size-3" />
                            {t('templates.enabled')}
                          </>
                        )}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[10px]"
                        onClick={() => {
                          setActiveId(profile.id)
                          setUsername('')
                          setPassword('')
                          setActiveResult(null)
                        }}
                      >
                        <Sparkles className="mr-1 size-3" />
                        {t('templates.enable')}
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <Dialog
        open={activeId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setActiveId(null)
            setActiveResult(null)
            setPassword('')
            setUsername('')
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('templates.dialog.title', { name: activeProfile?.displayName ?? '' })}
            </DialogTitle>
            <DialogDescription>{activeProfile?.domain}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="tpl-username" className="text-xs">
                {t('templates.dialog.username')}
              </label>
              <Input
                id="tpl-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
                className="h-8 text-xs"
                disabled={submitting}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="tpl-password" className="text-xs">
                {t('templates.dialog.password')}
              </label>
              <Input
                id="tpl-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                className="h-8 text-xs"
                disabled={submitting}
              />
            </div>
            {activeResult && <VerificationResultCard result={activeResult} />}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setActiveId(null)}
              disabled={submitting}
            >
              {t('templates.dialog.cancel')}
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => void onEnable()}
              disabled={submitting}
            >
              {submitting && <Loader2 className="mr-1 size-3 animate-spin" />}
              {t('templates.dialog.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
