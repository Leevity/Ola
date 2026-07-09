// StepDriver: executes one step of a login run.
//
// Each step talks to the Browser* tools via handleNativeBrowserToolRequest
// (already wired up in the renderer) and the credentials:fill-password IPC
// (which runs the password injection in the main process; plaintext never
// crosses the renderer boundary).
//
// The driver is intentionally synchronous-step: it awaits one step, returns
// a StepResult, and the state machine decides what to do next.

import { IPC } from '../ipc/channels'
import { ipcClient } from '../ipc/ipc-client'
import { useUIStore } from '@renderer/stores/ui-store'
import i18n from '@renderer/locales'
import { findSiteProfileByDomain } from './site-profiles'
import { detectChallenge, snapshotFromHtml } from './challenge-detector'
import { decodeStructuredToolResult } from '../tools/tool-result-format'
import type {
  LoginRunState,
  LoginStepId,
  LoginStepState,
  FillPasswordResponse
} from '../../../../shared/credentials'
import { isWebviewConnected } from '../browser/webview-helpers'
import { handleNativeBrowserToolRequest } from '../tools/browser-native-ui'

export interface StepResult {
  status: 'success' | 'failed' | 'awaiting_human'
  message: string
  errorDetail?: string
  artifacts?: LoginStepState['artifacts']
}

function t(key: string, values?: Record<string, unknown>): string {
  return i18n.t(`login:messages.${key}`, values)
}

interface BrowserToolResponse {
  content?: unknown
  isError?: boolean
  error?: string
}

function pickWebContentsId(run: LoginRunState): number | null {
  return useUIStore.getState().getBrowserWebContentsId(run.sessionId ?? null, run.projectId ?? null)
}

function getRunDebugContext(run: LoginRunState): Record<string, unknown> {
  const state = useUIStore.getState()
  return {
    domain: run.domain,
    sessionId: run.sessionId ?? null,
    projectId: run.projectId ?? null,
    url: state.getBrowserState(run.sessionId ?? null, run.projectId ?? null).url,
    webContentsId: state.getBrowserWebContentsId(run.sessionId ?? null, run.projectId ?? null)
  }
}

function logStepFailure(
  run: LoginRunState,
  stepId: LoginStepId,
  message: string,
  details?: Record<string, unknown>
): void {
  if (!import.meta.env.DEV) return
  console.error('[credentials:step-failed]', {
    stepId,
    message,
    ...getRunDebugContext(run),
    ...(details ?? {})
  })
}

async function invokeBrowserTool(
  toolName: string,
  input: Record<string, unknown>,
  run: LoginRunState
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    const res = (await handleNativeBrowserToolRequest({
      toolName,
      input,
      sessionId: run.sessionId ?? null,
      projectId: run.projectId ?? null,
      toolUseId: `step-${Date.now()}`,
      runId: `login-${Date.now()}`
    })) as BrowserToolResponse
    if (res.isError) {
      return { ok: false, error: res.error ?? 'browser tool error' }
    }
    if (typeof res.content === 'string') {
      const parsed = decodeStructuredToolResult(res.content)
      if (parsed && !Array.isArray(parsed)) {
        if (typeof parsed.error === 'string') {
          return { ok: false, error: parsed.error }
        }
        return { ok: true, data: parsed }
      }
    }
    return { ok: true, data: res.content }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function waitForSelector(
  selector: string,
  run: LoginRunState,
  timeoutMs = 8000
): Promise<{ found: boolean; lastError?: string; snapshot?: unknown }> {
  const startedAt = Date.now()
  let lastError: string | undefined
  let snapshot: unknown
  while (Date.now() - startedAt < timeoutMs) {
    const res = await invokeBrowserTool(
      'BrowserGetContent',
      {
        type: 'html',
        selector
      },
      run
    )
    if (res.ok) return { found: true }
    lastError = res.error
    const page = await invokeBrowserTool('BrowserGetContent', { type: 'html' }, run)
    if (page.ok) snapshot = page.data
    await sleep(250)
  }
  return { found: false, lastError, snapshot }
}

async function waitForBrowserIdle(run: LoginRunState, timeoutMs = 10000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const loading = useUIStore
      .getState()
      .getBrowserState(run.sessionId ?? null, run.projectId ?? null).loading
    if (!loading) return
    await sleep(250)
  }
}

export class StepDriver {
  async runStep(stepId: LoginStepId, run: LoginRunState): Promise<StepResult> {
    switch (stepId) {
      case 'navigate':
        return this.navigate(run)
      case 'detect_form':
        return this.detectForm(run)
      case 'fill_username':
        return this.fillUsername(run)
      case 'fill_password':
        return this.fillPassword(run)
      case 'submit':
        return this.submit(run)
      case 'inspect_result':
        return this.inspectResult(run)
      default:
        return { status: 'success', message: 'no-op step' }
    }
  }

  private async navigate(run: LoginRunState): Promise<StepResult> {
    const profile = findSiteProfileByDomain(run.domain)
    const url = profile?.loginUrl ?? `https://${run.domain}`
    // Set the URL via store — the embedded BrowserPanel listens to this.
    // IMPORTANT: pass null (not undefined) for sessionId/projectId so the
    // scope key matches what BrowserPanel uses (it receives null from
    // CredentialsPanel). undefined would resolve to the active session
    // which is a different key.
    useUIStore.getState().setBrowserUrl(url, null, null)
    // Give the webview a moment to start loading.
    await sleep(500)
    // Try to wait for load; if webview ref is not yet populated, just
    // report success after a short delay — the page is loading.
    const webview = useUIStore
      .getState()
      .getBrowserWebviewRef(run.sessionId ?? null, run.projectId ?? null)?.current
    if (isWebviewConnected(webview)) {
      await Promise.race([
        new Promise<void>((resolve) => {
          const onDidFinishLoad = (): void => {
            webview.removeEventListener('did-finish-load', onDidFinishLoad)
            resolve()
          }
          webview.addEventListener('did-finish-load', onDidFinishLoad)
        }),
        sleep(10000)
      ])
    }
    return { status: 'success', message: t('opened', { url }) }
  }

  private async detectForm(run: LoginRunState): Promise<StepResult> {
    const profile = findSiteProfileByDomain(run.domain)
    if (!profile) {
      return {
        status: 'failed',
        message: t('noProfile', { domain: run.domain }),
        errorDetail: 'no site profile'
      }
    }
    // NOTE: we no longer check isWebviewConnected here — the BrowserPanel
    // webview ref is set asynchronously in a useEffect; by the time
    // detectForm runs the ref may not be populated yet even though the
    // webview is actually loaded. The Browser* tools themselves will fail
    // with a clear error if the webview is truly disconnected.
    return {
      status: 'success',
      message: t('formLocated', {
        usernameSelector: profile.usernameSelector,
        passwordSelector: profile.passwordSelector
      }),
      artifacts: {
        detectedUsernameSelector: profile.usernameSelector,
        detectedPasswordSelector: profile.passwordSelector,
        detectedSubmitSelector: profile.submitSelector
      }
    }
  }

  private async fillUsername(run: LoginRunState): Promise<StepResult> {
    const sel = run.stepStates.detect_form.artifacts?.detectedUsernameSelector
    if (!sel) {
      logStepFailure(run, 'fill_username', 'missing username selector')
      return { status: 'failed', message: t('missingUsernameSelector'), errorDetail: 'no selector' }
    }
    const ready = await waitForSelector(sel, run)
    if (!ready.found) {
      logStepFailure(run, 'fill_username', 'username selector did not appear', {
        selector: sel,
        error: ready.lastError,
        snapshot: ready.snapshot
      })
      return {
        status: 'failed',
        message: t('fillUsernameFailed'),
        errorDetail: `selector not found: ${sel}`
      }
    }
    const res = await invokeBrowserTool(
      'BrowserType',
      {
        selector: sel,
        text: run.username,
        clear: true
      },
      run
    )
    if (!res.ok) {
      logStepFailure(run, 'fill_username', 'BrowserType failed', {
        selector: sel,
        error: res.error
      })
      return { status: 'failed', message: t('fillUsernameFailed'), errorDetail: res.error }
    }
    return { status: 'success', message: t('usernameFilled') }
  }

  private async fillPassword(run: LoginRunState): Promise<StepResult> {
    const sel = run.stepStates.detect_form.artifacts?.detectedPasswordSelector
    if (!sel) {
      logStepFailure(run, 'fill_password', 'missing password selector')
      return { status: 'failed', message: t('missingPasswordSelector'), errorDetail: 'no selector' }
    }
    const ready = await waitForSelector(sel, run)
    if (!ready.found) {
      logStepFailure(run, 'fill_password', 'password selector did not appear', {
        selector: sel,
        error: ready.lastError,
        snapshot: ready.snapshot
      })
      return {
        status: 'failed',
        message: t('passwordFailed'),
        errorDetail: `selector not found: ${sel}`
      }
    }
    const webContentsId = pickWebContentsId(run)
    if (!webContentsId) {
      logStepFailure(run, 'fill_password', 'browser webContents is not ready')
      return {
        status: 'failed',
        message: t('passwordFailed'),
        errorDetail: 'browser webContents is not ready'
      }
    }
    const res = (await ipcClient.invoke(IPC.CREDENTIALS_FILL_PASSWORD, {
      credentialId: run.credentialId,
      webContentsId,
      selector: sel
    })) as FillPasswordResponse
    if (res.status === 'filled') {
      return { status: 'success', message: t('passwordFilled') }
    }
    return {
      status: 'failed',
      message: t('passwordFailed'),
      errorDetail: res.error ?? res.status
    }
  }

  private async submit(run: LoginRunState): Promise<StepResult> {
    const sel = run.stepStates.detect_form.artifacts?.detectedSubmitSelector
    if (!sel) {
      logStepFailure(run, 'submit', 'missing submit selector')
      return { status: 'failed', message: t('missingSubmitSelector'), errorDetail: 'no selector' }
    }
    const res = await invokeBrowserTool('BrowserClick', { selector: sel }, run)
    if (!res.ok) {
      logStepFailure(run, 'submit', 'BrowserClick failed', { selector: sel, error: res.error })
      return { status: 'failed', message: t('submitFailed'), errorDetail: res.error }
    }
    return { status: 'success', message: t('submitted') }
  }

  private async inspectResult(run: LoginRunState): Promise<StepResult> {
    // Give the page 2.5s to react to the submit.
    await sleep(2500)
    await waitForBrowserIdle(run)
    const res = await invokeBrowserTool('BrowserGetContent', { type: 'html' }, run)
    if (!res.ok || !res.data) {
      logStepFailure(run, 'inspect_result', 'BrowserGetContent failed', { error: res.error })
      return {
        status: 'failed',
        message: t('contentUnavailable'),
        errorDetail: res.error ?? 'empty content'
      }
    }
    const state = useUIStore.getState()
    const browserState = state.getBrowserState?.(run.sessionId ?? null)
    const data = res.data as { url?: string; content?: string } | string
    const url = typeof data === 'object' && data?.url ? data.url : (browserState?.url ?? '')
    const html = typeof data === 'object' && data?.content ? data.content : String(data ?? '')
    const snapshot = snapshotFromHtml(url, html)
    const challenge = detectChallenge(snapshot)
    if (challenge) {
      return {
        status: 'awaiting_human',
        message: t('challengeDetected', { kind: challenge.kind }),
        artifacts: { challenge }
      }
    }
    const profile = findSiteProfileByDomain(run.domain)
    if (profile && this.successIndicatorMet(url, profile.successIndicator)) {
      return { status: 'success', message: t('loginSuccess') }
    }
    return {
      status: 'failed',
      message: t('successNotDetected'),
      errorDetail: `url=${url}`
    }
  }

  private successIndicatorMet(url: string, indicator: { type: string; value: string }): boolean {
    const lower = url.toLowerCase()
    const value = indicator.value.toLowerCase()
    if (indicator.type === 'url_contains') return lower.includes(value)
    if (indicator.type === 'url_not_contains') return !lower.includes(value)
    return lower.includes(value)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
