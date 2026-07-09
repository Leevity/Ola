import { CheckCircle2, AlertTriangle, XCircle, HelpCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { VerificationResult } from '../../../../shared/credentials'

interface Props {
  result: VerificationResult | null | undefined
  compact?: boolean
}

const KIND_LABEL: Record<string, string> = {
  recaptcha_v2: 'reCAPTCHA v2',
  recaptcha_v3: 'reCAPTCHA v3',
  hcaptcha: 'hCaptcha',
  turnstile: 'Cloudflare Turnstile',
  slider_puzzle: 'slider puzzle',
  device_fingerprint: 'device fingerprint',
  totp_required: 'two-factor authentication',
  phone_verification: 'phone verification',
  email_verification: 'email verification',
  unknown_challenge: 'an unknown challenge'
}

export function VerificationResultCard({ result, compact = false }: Props): React.JSX.Element {
  const { t } = useTranslation('credentials')
  if (!result) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <HelpCircle className="size-3.5" />
        {t('list.neverVerified')}
      </div>
    )
  }
  if (result.status === 'pass') {
    return (
      <div
        className={`flex items-start gap-2 rounded-md border border-emerald-300/60 bg-emerald-50/60 px-3 ${
          compact ? 'py-1.5 text-[11px]' : 'py-2 text-xs'
        } text-emerald-900 dark:border-emerald-700/40 dark:bg-emerald-900/20 dark:text-emerald-100`}
      >
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
        <div>
          <div className="font-medium">{t('result.pass.title')}</div>
          {!compact && <div className="opacity-80">{t('result.pass.description')}</div>}
        </div>
      </div>
    )
  }
  if (result.status === 'challenge') {
    const kindLabel = result.challenge ? KIND_LABEL[result.challenge.kind] : 'automation'
    return (
      <div
        className={`flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50/60 px-3 ${
          compact ? 'py-1.5 text-[11px]' : 'py-2 text-xs'
        } text-amber-900 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-100`}
      >
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <div>
          <div className="font-medium">{t('result.challenge.title')}</div>
          {!compact && (
            <div className="opacity-80">
              {t('result.challenge.description', { kind: kindLabel })}
            </div>
          )}
        </div>
      </div>
    )
  }
  // fail
  return (
    <div
      className={`flex items-start gap-2 rounded-md border border-rose-300/60 bg-rose-50/60 px-3 ${
        compact ? 'py-1.5 text-[11px]' : 'py-2 text-xs'
      } text-rose-900 dark:border-rose-700/40 dark:bg-rose-900/20 dark:text-rose-100`}
    >
      <XCircle className="mt-0.5 size-3.5 shrink-0" />
      <div>
        <div className="font-medium">{t('result.fail.title')}</div>
        {!compact && result.failureReason && (
          <div className="opacity-80">
            {t('result.fail.description', { reason: result.failureReason })}
          </div>
        )}
      </div>
    </div>
  )
}
