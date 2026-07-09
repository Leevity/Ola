// LoginStepPanel: a one-row status strip rendered at the top of
// BrowserPanel, just under the address bar. It shows the 6 steps of the
// active login run plus 4 action buttons.
//
// In PR2-A this is a static shell: the panel subscribes to login-run-store
// and reflects whatever is in there. The state machine that actually
// drives the steps ships in PR2-B.

import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CheckCircle2, XCircle, Hand, Loader2, SkipForward, Circle, Eye } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useLoginRunStore } from '@renderer/stores/login-run-store'
import { useCredentialsStore } from '@renderer/stores/credentials-store'
import { startLoginRun } from '@renderer/lib/credentials/login-state-machine'
import {
  LOGIN_RUN_STEPS,
  type LoginStepId,
  type LoginStepState,
  type LoginStepStatus
} from '../../../../shared/credentials'

const STEP_TRANSLATION_KEYS: Record<LoginStepId, string> = {
  idle: 'steps.idle',
  navigate: 'steps.navigate',
  detect_form: 'steps.detect_form',
  fill_username: 'steps.fill_username',
  fill_password: 'steps.fill_password',
  submit: 'steps.submit',
  inspect_result: 'steps.inspect_result',
  done: 'steps.done',
  paused: 'steps.paused',
  failed: 'steps.failed'
}

interface StepIconProps {
  status: LoginStepStatus
  isCurrent: boolean
}

function StepIcon({ status, isCurrent }: StepIconProps): React.JSX.Element {
  const className = 'size-3.5'
  switch (status) {
    case 'success':
      return <CheckCircle2 className={`${className} text-emerald-500`} />
    case 'failed':
      return <XCircle className={`${className} text-rose-500`} />
    case 'awaiting_human':
      return <Hand className={`${className} text-amber-500`} />
    case 'skipped':
      return <SkipForward className={`${className} text-muted-foreground`} />
    case 'in_progress':
      return <Loader2 className={`${className} animate-spin text-primary`} />
    case 'pending':
    default:
      return (
        <Circle
          className={`${className} ${isCurrent ? 'text-primary' : 'text-muted-foreground/40'}`}
        />
      )
  }
}

function stepBgClass(status: LoginStepStatus, isCurrent: boolean): string {
  switch (status) {
    case 'success':
      return 'bg-emerald-50/40 border-emerald-300/40 dark:bg-emerald-900/10'
    case 'failed':
      return 'bg-rose-50/40 border-rose-300/40 dark:bg-rose-900/10'
    case 'awaiting_human':
      return 'bg-amber-50/60 border-amber-300/60 dark:bg-amber-900/20'
    case 'skipped':
      return 'bg-muted/40 border-border/40 opacity-60'
    case 'in_progress':
      return 'bg-primary/5 border-primary/30'
    case 'pending':
    default:
      if (isCurrent) return 'bg-primary/10 border-primary/40'
      return 'bg-muted/20 border-border/30'
  }
}

export function LoginStepPanel(): React.JSX.Element | null {
  const { t } = useTranslation('login')
  const run = useLoginRunStore((s) => s.run)
  const machine = useLoginRunStore((s) => s.machine)
  const clear = useLoginRunStore((s) => s.clear)
  const refs = useCredentialsStore((s) => s.refs)

  if (!run) return null

  const isHuman = run.handoff.mode === 'human'
  const currentStepId: LoginStepId = LOGIN_RUN_STEPS.includes(run.currentStep)
    ? run.currentStep
    : 'inspect_result'
  const currentStepState: LoginStepState = run.stepStates[currentStepId]
  const canStart = currentStepState.status === 'pending'
  const hasMachine = Boolean(machine)

  const onStart = async (): Promise<void> => {
    try {
      const ref = refs.find((r) => r.domain === run.domain) ?? refs[0]
      if (!ref) {
        toast.error(t('errors.noCredential'))
        return
      }
      if (ref.domain !== run.domain) {
        toast.warning(
          t('warnings.domainMismatch', { credentialDomain: ref.domain, runDomain: run.domain })
        )
      }
      await startLoginRun({
        domain: ref.domain,
        credentialId: ref.id,
        username: ref.usernameHint ?? '',
        sessionId: run.sessionId ?? null,
        projectId: run.projectId ?? null
      })
    } catch (err) {
      console.error('[LoginStepPanel] startLoginRun failed:', err)
      toast.error(
        t('errors.startFailed', { error: err instanceof Error ? err.message : String(err) })
      )
    }
  }

  return (
    <div
      data-testid="login-step-panel"
      className={`flex shrink-0 flex-col gap-1.5 border-b px-2 py-1.5 ${
        isHuman
          ? 'border-amber-300/60 bg-amber-50/40 dark:border-amber-700/40 dark:bg-amber-900/15'
          : 'border-border/50 bg-muted/20'
      }`}
    >
      {/* Step strip — 6 step indicators, order preserved */}
      <div className="flex items-center gap-1.5 overflow-x-auto">
        {LOGIN_RUN_STEPS.map((id, idx) => {
          const state = run.stepStates[id]
          const isCurrent = run.currentStep === id
          return (
            <div
              key={id}
              data-testid={`login-step-${id}`}
              data-step-status={state.status}
              data-step-current={isCurrent}
              title={t(STEP_TRANSLATION_KEYS[id])}
              className={`flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] ${stepBgClass(
                state.status,
                isCurrent
              )}`}
            >
              <span className="font-mono text-[9px] text-muted-foreground">{idx + 1}</span>
              <StepIcon status={state.status} isCurrent={isCurrent} />
              <span className="whitespace-nowrap font-medium">{t(STEP_TRANSLATION_KEYS[id])}</span>
              {state.finishedAt && state.startedAt ? (
                <span className="text-[9px] text-muted-foreground">
                  {((state.finishedAt - state.startedAt) / 1000).toFixed(1)}s
                </span>
              ) : null}
            </div>
          )
        })}
      </div>

      {/* Current step message + handoff controls */}
      <div className="flex items-center gap-2 text-[11px]">
        {canStart ? (
          <Button
            size="sm"
            className="h-6 px-2 text-[10px]"
            onClick={() => void onStart()}
            data-testid="login-start"
          >
            {t('actions.start')}
          </Button>
        ) : null}
        <span className="text-muted-foreground">
          {isHuman
            ? t('handoff.active')
            : t('current', { step: t(STEP_TRANSLATION_KEYS[run.currentStep]) })}
        </span>
        <span className="min-w-0 flex-1 truncate text-foreground">
          {currentStepState.message || (isHuman ? t('handoff.takeOver') : t('awaiting'))}
        </span>
        {isHuman ? (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[10px]"
              data-testid="login-handoff-resume"
              onClick={() => machine?.resumeFromHandoff()}
              disabled={!hasMachine}
            >
              {t('handoff.resume')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={() => machine?.skipCurrentStep()}
              disabled={!hasMachine}
            >
              {t('handoff.reportDone')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={() => machine?.reportFailed()}
              disabled={!hasMachine}
            >
              {t('handoff.reportFailed')}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[10px]"
              data-testid="login-takeover"
              onClick={() => machine?.requestHandoff('user_requested')}
              disabled={!hasMachine || currentStepState.status !== 'in_progress'}
            >
              <Hand className="mr-1 size-3" />
              {t('actions.takeover')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={() => machine?.skipCurrentStep()}
              disabled={!hasMachine || currentStepState.status === 'in_progress'}
            >
              {t('actions.skip')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={() => machine?.retryCurrentStep()}
              disabled={!hasMachine || currentStepState.status === 'in_progress'}
            >
              {t('actions.retry')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={() => machine?.cancel()}
              disabled={!hasMachine}
            >
              {t('actions.cancel')}
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-5 text-muted-foreground"
          onClick={() => clear()}
          title={t('actions.clear')}
        >
          <Eye className="size-3" />
        </Button>
      </div>
    </div>
  )
}
