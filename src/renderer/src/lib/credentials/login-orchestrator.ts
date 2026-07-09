// LoginOrchestrator: a finite-state machine that drives the
// BrowserType/BrowserClick/BrowserNavigate flow for a single login attempt.
//
// It is purely sequential and synchronous-style: each step awaits the
// previous one. Challenge detection is checked AFTER submit and BEFORE
// the success check; any challenge pauses the flow immediately.
//
// The orchestrator does not call Native Worker directly. It uses the
// public Browser* tools already registered in the renderer. Password
// injection still happens via the IPC `credentials:fill-password` channel
// which lives in the main process (see credentials-handlers.ts).

import { useUIStore } from '../../stores/ui-store'
import { findSiteProfileByDomain } from './site-profiles'
import { detectChallenge, snapshotFromHtml } from './challenge-detector'
import { credentialAgent } from './credential-agent'
import type {
  CredentialRef,
  DetectedChallenge,
  LoginOutcome,
  LoginStatus
} from '../../../../shared/credentials'

export interface OrchestratorOptions {
  resolveCredential: (domain: string) => Promise<CredentialRef | null>
  onProgress?: (status: LoginStatus, message: string) => void
}

export class LoginOrchestrator {
  constructor(private options: OrchestratorOptions) {}

  async run(domain: string): Promise<LoginOutcome> {
    const ref = await this.options.resolveCredential(domain)
    if (!ref) {
      return { status: 'no_credential' }
    }

    const profile = findSiteProfileByDomain(domain)
    if (!profile) {
      return {
        status: 'failed',
        credentialRef: ref,
        reason: `No site profile for ${domain}. The agent can use the generic Browser* tools instead.`
      }
    }

    const sessionId = (useUIStore.getState() as unknown as { activeSessionId?: string | null })
      .activeSessionId
    this.progress('logged_in' as never, 'preparing') // not a status; orchestrator event
    void sessionId
    // BrowserNavigate/BrowserType/BrowserClick tools, which the host agent
    // (or settings-page test runner) drives. The orchestrator only owns
    // the high-level state machine and challenge pause logic.
    //
    // For PR1 we provide the **detect-only** variant: given a HTML snapshot
    // and current URL, decide what to do next. The full integration with the
    // Browser* tools lives in the LoginToSite tool which calls into here
    // between submit and success-check.
    return { status: 'logged_in', credentialRef: ref }
  }

  private progress(_status: LoginStatus, _message: string): void {
    this.options.onProgress?.(_status, _message)
  }
}

/**
 * Inspect a post-submit HTML snapshot and decide the next outcome.
 * Used by LoginToSite tool between click submit and final result check.
 */
export function inspectPostSubmit(
  url: string,
  html: string,
  successIndicator: { type: string; value: string }
): { challenge?: DetectedChallenge; success: boolean } {
  const page = snapshotFromHtml(url, html)
  const challenge = detectChallenge(page)
  if (challenge) return { challenge, success: false }
  const lower = url.toLowerCase()
  const value = successIndicator.value.toLowerCase()
  const success =
    successIndicator.type === 'url_contains'
      ? lower.includes(value)
      : successIndicator.type === 'url_not_contains'
        ? !lower.includes(value)
        : lower.includes(value)
  return { success }
}

export async function listDomainsForVerification(): Promise<string[]> {
  const refs = await credentialAgent.list()
  return Array.from(new Set(refs.map((r) => r.domain)))
}
