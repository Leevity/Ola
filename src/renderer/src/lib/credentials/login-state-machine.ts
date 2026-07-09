// LoginStateMachine: 6-step login run controller.
//
// Owns a single LoginRunState at a time, exposed via login-run-store.
// Each step is executed by StepDriver.runStep(); results mutate the run
// and the store is updated so React components (LoginStepPanel) re-render.
//
// In PR2-B we cover the 6 steps + handoff basics. PR2-C adds user-facing
// handoff controls and 2x retry per step.

import { useLoginRunStore } from '@renderer/stores/login-run-store'
import i18n from '@renderer/locales'
import { StepDriver } from './step-driver'
import {
  LOGIN_RUN_STEPS,
  type LoginRunState,
  type LoginStepId,
  type LoginStepState,
  type LoginOutcome,
  type HandoffReason
} from '../../../../shared/credentials'

const RETRYABLE_STEPS: LoginStepId[] = ['fill_username', 'fill_password', 'submit']
const MAX_RETRIES = 2

function t(key: string, values?: Record<string, unknown>): string {
  return i18n.t(`login:messages.${key}`, values)
}

export class LoginStateMachine {
  private run: LoginRunState
  private driver: StepDriver
  private cancelled = false
  private resumeWaiter: (() => void) | null = null

  constructor(run: LoginRunState) {
    this.run = run
    this.driver = new StepDriver()
  }

  async start(): Promise<LoginOutcome> {
    const store = useLoginRunStore.getState()
    store.setMachine(this)
    store.setRun({ ...this.run })
    try {
      for (const stepId of this.run.steps) {
        if (this.cancelled) return { status: 'cancelled', reason: 'cancelled' }
        if (this.run.handoff.mode === 'human') {
          this.publish()
          await this.waitForResume()
        }
        const result = await this.executeStepWithRetry(stepId)
        if (result === 'failed') {
          this.run.result = 'fail'
          this.publish()
          useLoginRunStore.getState().setMachine(null)
          return {
            status: 'failed',
            reason: this.run.stepStates[stepId].errorDetail ?? 'step failed'
          }
        }
        if (result === 'awaiting_human') {
          this.run.result = 'challenge'
          this.run.handoff = { mode: 'human', reason: 'challenge_detected' }
          this.publish()
          await this.waitForResume()
          if (this.cancelled) {
            useLoginRunStore.getState().setMachine(null)
            return { status: 'cancelled', reason: 'cancelled' }
          }
          const currentState = this.run.stepStates[stepId]
          if (currentState.status === 'skipped' || currentState.status === 'success') {
            continue
          }
          const resumed = await this.executeStep('inspect_result')
          if (resumed !== 'success') {
            useLoginRunStore.getState().setMachine(null)
            return {
              status: resumed === 'awaiting_human' ? 'paused_for_challenge' : 'failed',
              challenge: this.run.stepStates[stepId].artifacts?.challenge,
              reason: this.run.stepStates[stepId].errorDetail
            }
          }
          continue
        }
      }
      this.run.result = 'pass'
      this.run.currentStep = 'done'
      this.publish()
      useLoginRunStore.getState().setMachine(null)
      return { status: 'logged_in' }
    } catch (e) {
      this.run.result = 'fail'
      this.publish()
      useLoginRunStore.getState().setMachine(null)
      return { status: 'failed', reason: String(e) }
    }
  }

  requestHandoff(reason: HandoffReason = 'user_requested'): void {
    this.run.handoff = { mode: 'human', reason }
    const s = this.run.stepStates[this.run.currentStep]
    if (s.status === 'in_progress' || s.status === 'pending') {
      s.status = 'awaiting_human'
      s.message = reason === 'user_requested' ? t('handoffRequested') : s.message
    }
    this.publish()
  }

  resumeFromHandoff(): void {
    this.run.handoff = { mode: 'agent' }
    this.publish()
    this.resumeWaiter?.()
    this.resumeWaiter = null
  }

  skipCurrentStep(): void {
    const s = this.run.stepStates[this.run.currentStep]
    s.status = 'skipped'
    s.message = t('skipped')
    s.finishedAt = Date.now()
    this.run.handoff = { mode: 'agent' }
    this.publish()
    this.resumeWaiter?.()
    this.resumeWaiter = null
  }

  retryCurrentStep(): void {
    this.run.handoff = { mode: 'agent' }
    void this.executeStep(this.run.currentStep)
  }

  cancel(): void {
    this.cancelled = true
    this.run.result = 'fail'
    const s = this.run.stepStates[this.run.currentStep]
    s.status = 'failed'
    s.message = t('cancelled')
    s.finishedAt = Date.now()
    this.publish()
    useLoginRunStore.getState().setMachine(null)
    this.resumeWaiter?.()
    this.resumeWaiter = null
  }

  reportFailed(): void {
    this.cancel()
  }

  private waitForResume(): Promise<void> {
    if (this.run.handoff.mode === 'agent' || this.cancelled) return Promise.resolve()
    return new Promise((resolve) => {
      this.resumeWaiter = resolve
    })
  }

  private async executeStepWithRetry(
    stepId: LoginStepId
  ): Promise<'success' | 'failed' | 'awaiting_human'> {
    let result = await this.executeStep(stepId)
    if (result !== 'failed' || !RETRYABLE_STEPS.includes(stepId)) return result
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      const state = this.run.stepStates[stepId]
      state.status = 'pending'
      state.message = t('retrying', { attempt })
      state.errorDetail = undefined
      state.startedAt = undefined
      state.finishedAt = undefined
      this.publish()
      result = await this.executeStep(stepId)
      if (result !== 'failed') break
    }
    if (result === 'failed') {
      this.run.stepStates[stepId].message = t('retryExhausted', { count: MAX_RETRIES })
      this.publish()
    }
    return result
  }

  private async executeStep(stepId: LoginStepId): Promise<'success' | 'failed' | 'awaiting_human'> {
    this.run.currentStep = stepId
    const state = this.run.stepStates[stepId]
    state.status = 'in_progress'
    state.startedAt = Date.now()
    state.message = ''
    state.errorDetail = undefined
    this.publish()

    let result
    try {
      result = await this.driver.runStep(stepId, this.run)
    } catch (e) {
      result = {
        status: 'failed' as const,
        message: 'step threw',
        errorDetail: e instanceof Error ? e.message : String(e)
      }
    }

    state.finishedAt = Date.now()
    state.status = result.status
    state.message = result.message
    if (result.errorDetail) state.errorDetail = result.errorDetail
    if (result.artifacts) {
      state.artifacts = { ...(state.artifacts ?? {}), ...result.artifacts }
    }
    this.publish()
    return result.status
  }

  private publish(): void {
    useLoginRunStore.getState().setRun({ ...this.run })
  }
}

// Convenience: start a run for a (domain, credentialId, username) triple
// in one call. Returns the outcome once the run completes or pauses.
export async function startLoginRun(input: {
  domain: string
  credentialId: string
  username: string
  sessionId?: string | null
  projectId?: string | null
}): Promise<LoginOutcome> {
  const run: LoginRunState = {
    id: `run-${Date.now()}`,
    domain: input.domain,
    credentialId: input.credentialId,
    username: input.username,
    sessionId: input.sessionId ?? null,
    projectId: input.projectId ?? null,
    startedAt: Date.now(),
    currentStep: 'navigate',
    steps: [...LOGIN_RUN_STEPS],
    stepStates: buildEmptyStepStates(),
    handoff: { mode: 'agent' }
  }
  const machine = new LoginStateMachine(run)
  return await machine.start()
}

function buildEmptyStepStates(): Record<LoginStepId, LoginStepState> {
  const states = {} as Record<LoginStepId, LoginStepState>
  for (const id of LOGIN_RUN_STEPS) {
    states[id] = { id, status: 'pending', message: '' }
  }
  return states
}
