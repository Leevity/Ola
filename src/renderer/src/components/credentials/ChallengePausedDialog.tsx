import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import type { DetectedChallenge } from '../../../../shared/credentials'

interface Props {
  open: boolean
  domain: string | null
  username: string | null
  challenge: DetectedChallenge | null
  onComplete: () => void
  onCancel: () => void
}

const KIND_LABEL: Record<string, string> = {
  recaptcha_v2: 'reCAPTCHA v2',
  recaptcha_v3: 'reCAPTCHA v3',
  hcaptcha: 'hCaptcha',
  turnstile: 'Cloudflare Turnstile',
  slider_puzzle: 'slider puzzle',
  device_fingerprint: 'device fingerprint check',
  totp_required: 'two-factor authentication',
  phone_verification: 'phone verification',
  email_verification: 'email verification',
  unknown_challenge: 'an unknown automation challenge'
}

export function ChallengePausedDialog({
  open,
  domain,
  username,
  challenge,
  onComplete,
  onCancel
}: Props): React.JSX.Element {
  const { t } = useTranslation('credentials')
  const kindLabel = challenge ? (KIND_LABEL[challenge.kind] ?? 'an automation challenge') : ''
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-300">
            <AlertTriangle className="size-5" />
            <DialogTitle>Login paused — manual action required</DialogTitle>
          </div>
          <DialogDescription>
            The credential agent has filled in your username and password and clicked Sign in. The
            site is now showing {kindLabel}, which cannot be solved automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-amber-300/60 bg-amber-50/40 p-3 text-xs dark:border-amber-700/40 dark:bg-amber-900/20">
          <div>
            <span className="text-muted-foreground">Site:</span> {domain ?? '—'}
          </div>
          <div>
            <span className="text-muted-foreground">Account:</span> {username ?? '—'}
          </div>
          <div>
            <span className="text-muted-foreground">Challenge:</span> {kindLabel}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('approval.description', { domain: domain ?? '', username: username ?? '' })}
        </p>
        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>
            <X className="mr-1 size-3" />
            Cancel login
          </Button>
          <Button size="sm" className="h-7 text-xs" onClick={onComplete}>
            <Check className="mr-1 size-3" />I have completed it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
