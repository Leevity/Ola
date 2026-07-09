import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  Square,
  Globe,
  AlertCircle,
  KeyRound,
  ShieldCheck
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useUIStore } from '@renderer/stores/ui-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useCredentialsStore } from '@renderer/stores/credentials-store'
import { getBrowserAccessDecision } from '@renderer/lib/app-plugin/browser-access'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import {
  describeWebviewOperationError,
  isPromiseLike,
  isWebviewConnected,
  type MaybePromise
} from '@renderer/lib/browser/webview-helpers'
import { useTranslation } from 'react-i18next'
import {
  LoginProgressOverlay,
  type LoginProgressStep
} from '@renderer/components/credentials/LoginProgressOverlay'
import { LoginStepPanel } from '@renderer/components/credentials/LoginStepPanel'
import {
  BUILTIN_BROWSER_PARTITION,
  stripElectronFromUserAgent
} from '../../../../shared/browser-plugin'

export function BrowserPanel({
  sessionId = null,
  projectId = null
}: {
  sessionId?: string | null
  projectId?: string | null
}): React.JSX.Element {
  const { t } = useTranslation('layout')

  const storedUrl = useUIStore((s) => s.getBrowserState(sessionId, projectId).url)
  const setBrowserUrl = useUIStore((s) => s.setBrowserUrl)
  const loading = useUIStore((s) => s.getBrowserState(sessionId, projectId).loading)
  const setBrowserLoading = useUIStore((s) => s.setBrowserLoading)
  const setBrowserPageTitle = useUIStore((s) => s.setBrowserPageTitle)
  const canGoBack = useUIStore((s) => s.getBrowserState(sessionId, projectId).canGoBack)
  const setBrowserCanGoBack = useUIStore((s) => s.setBrowserCanGoBack)
  const canGoForward = useUIStore((s) => s.getBrowserState(sessionId, projectId).canGoForward)
  const setBrowserCanGoForward = useUIStore((s) => s.setBrowserCanGoForward)
  const errorInfo = useUIStore((s) => s.getBrowserState(sessionId, projectId).errorInfo)
  const setBrowserErrorInfo = useUIStore((s) => s.setBrowserErrorInfo)
  const setBrowserWebviewRef = useUIStore((s) => s.setBrowserWebviewRef)
  const setBrowserWebContentsId = useUIStore((s) => s.setBrowserWebContentsId)
  const browserUserDataReuseEnabled = useSettingsStore((s) => s.browserUserDataReuseEnabled)

  const [inputUrl, setInputUrl] = useState(storedUrl)
  const [committedUrl, setCommittedUrl] = useState(storedUrl)
  const [runtimeBrowserUserDataReuseEnabled, setRuntimeBrowserUserDataReuseEnabled] = useState(
    browserUserDataReuseEnabled
  )
  const [runtimeBrowserUserAgent, setRuntimeBrowserUserAgent] = useState<string | undefined>(
    browserUserDataReuseEnabled ? stripElectronFromUserAgent(navigator.userAgent) : undefined
  )
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const internalBrowserUrlUpdateRef = useRef(false)
  const initialBrowserUserDataReuseEnabledRef = useRef(browserUserDataReuseEnabled)
  const [loginOverlayStep] = useState<LoginProgressStep | null>(null)
  const refs = useCredentialsStore((s) => s.refs)
  const webviewUserAgent = runtimeBrowserUserDataReuseEnabled ? runtimeBrowserUserAgent : undefined
  const webviewSessionProps: Record<string, string> = {
    ...(runtimeBrowserUserDataReuseEnabled ? {} : { partition: BUILTIN_BROWSER_PARTITION }),
    allowpopups: 'true',
    ...(runtimeBrowserUserDataReuseEnabled ? { plugins: 'true' } : {}),
    ...(webviewUserAgent ? { useragent: webviewUserAgent } : {})
  }

  useEffect(() => {
    let cancelled = false

    async function loadRuntimeBrowserMode(): Promise<void> {
      try {
        const result = (await ipcClient.invoke(IPC.BROWSER_EMULATION_STATUS)) as
          | { success: true; status: { reuseEnabled: boolean; userAgent: string } }
          | { success: false; error?: string }
        if (!cancelled && result.success) {
          setRuntimeBrowserUserDataReuseEnabled(result.status.reuseEnabled)
          setRuntimeBrowserUserAgent(result.status.userAgent)
        }
      } catch {
        if (!cancelled) {
          setRuntimeBrowserUserDataReuseEnabled(initialBrowserUserDataReuseEnabledRef.current)
          setRuntimeBrowserUserAgent(stripElectronFromUserAgent(navigator.userAgent))
        }
      }
    }

    void loadRuntimeBrowserMode()
    return () => {
      cancelled = true
    }
  }, [])

  const handleWebviewOperationError = useCallback(
    (action: string, error: unknown): void => {
      console.warn('[BrowserPanel] Webview operation failed:', {
        action,
        message: describeWebviewOperationError(action, error)
      })
      setBrowserLoading(false, sessionId, projectId)
      setBrowserCanGoBack(false, sessionId, projectId)
      setBrowserCanGoForward(false, sessionId, projectId)
    },
    [projectId, sessionId, setBrowserCanGoBack, setBrowserCanGoForward, setBrowserLoading]
  )

  const runWebviewCommand = useCallback(
    (action: string, command: (webview: Electron.WebviewTag) => MaybePromise<void>): void => {
      const wv = webviewRef.current
      if (!isWebviewConnected(wv)) return

      try {
        const result = command(wv)
        if (isPromiseLike(result)) {
          void Promise.resolve(result).catch((error) => handleWebviewOperationError(action, error))
        }
      } catch (error) {
        handleWebviewOperationError(action, error)
      }
    },
    [handleWebviewOperationError]
  )

  useEffect(() => {
    setBrowserWebviewRef(webviewRef, sessionId, projectId)
    return () => {
      setBrowserWebviewRef(null, sessionId, projectId)
      setBrowserWebContentsId(null, sessionId, projectId)
      setBrowserLoading(false, sessionId, projectId)
    }
  }, [projectId, sessionId, setBrowserLoading, setBrowserWebContentsId, setBrowserWebviewRef])

  useEffect(() => {
    setInputUrl(storedUrl)
    if (internalBrowserUrlUpdateRef.current) {
      internalBrowserUrlUpdateRef.current = false
      return
    }
    setCommittedUrl(storedUrl)
  }, [storedUrl])

  const normalizeUrl = (url: string): string => {
    let normalized = url.trim()
    if (!normalized) return ''
    if (!/^https?:\/\//i.test(normalized) && !normalized.startsWith('http://localhost')) {
      normalized = `https://${normalized}`
    }
    return normalized
  }

  const blockNavigation = useCallback(
    (url: string, reason?: string): void => {
      setBrowserErrorInfo(
        {
          code: -10,
          desc: reason ?? t('browser.blockedByRules'),
          url
        },
        sessionId,
        projectId
      )
      setBrowserLoading(false, sessionId, projectId)
    },
    [projectId, sessionId, setBrowserErrorInfo, setBrowserLoading, t]
  )

  const canNavigateTo = useCallback(
    (url: string): boolean => {
      const decision = getBrowserAccessDecision(url)
      if (decision.allowed) return true
      blockNavigation(url, decision.reason)
      return false
    },
    [blockNavigation]
  )

  const navigate = useCallback(
    (url: string): void => {
      const normalized = normalizeUrl(url)
      if (!normalized) return
      setInputUrl(normalized)
      if (!canNavigateTo(normalized)) return
      setCommittedUrl(normalized)
      setBrowserUrl(normalized, sessionId, projectId)
      setBrowserErrorInfo(null, sessionId, projectId)
      const wv = webviewRef.current
      if (isWebviewConnected(wv)) {
        try {
          wv.src = normalized
        } catch (error) {
          handleWebviewOperationError('navigate', error)
        }
      }
    },
    [
      canNavigateTo,
      handleWebviewOperationError,
      projectId,
      sessionId,
      setBrowserErrorInfo,
      setBrowserUrl
    ]
  )

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') navigate(inputUrl)
  }

  const updateNavState = useCallback(() => {
    const wv = webviewRef.current
    if (!isWebviewConnected(wv)) return

    try {
      setBrowserCanGoBack(wv.canGoBack(), sessionId, projectId)
      setBrowserCanGoForward(wv.canGoForward(), sessionId, projectId)
    } catch (error) {
      handleWebviewOperationError('read navigation state', error)
    }
  }, [
    handleWebviewOperationError,
    projectId,
    sessionId,
    setBrowserCanGoBack,
    setBrowserCanGoForward
  ])

  const updateWebContentsId = useCallback((): void => {
    const wv = webviewRef.current
    if (!isWebviewConnected(wv)) return
    try {
      setBrowserWebContentsId(wv.getWebContentsId(), sessionId, projectId)
    } catch {
      // Electron only exposes getWebContentsId after dom-ready.
    }
  }, [projectId, sessionId, setBrowserWebContentsId])

  // Compute the toolbar credential badge outside of JSX so the JSX stays
  // a pure render expression and React's error-boundary lint stays happy.
  const credentialBadge = useMemo<React.ReactNode>(() => {
    let host: string
    try {
      host = new URL(storedUrl).host.toLowerCase()
    } catch {
      return null
    }
    const matched = refs.find((r) => host === r.domain || host.endsWith(`.${r.domain}`))
    if (!matched) return null
    const verified = matched.lastVerificationStatus === 'pass'
    return (
      <div
        className={`flex shrink-0 max-w-[140px] items-center gap-1 truncate rounded-md px-2 h-6 text-[10px] ${
          verified
            ? 'border border-emerald-300/60 bg-emerald-50/40 text-emerald-900 dark:border-emerald-700/40 dark:bg-emerald-900/20 dark:text-emerald-100'
            : 'border border-amber-300/60 bg-amber-50/40 text-amber-900 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-100'
        }`}
        title={
          verified
            ? `Logged in as ${matched.usernameHint ?? ''} for ${matched.domain}`
            : `Credential stored but not verified (${matched.lastVerificationStatus ?? 'unknown'})`
        }
      >
        {verified ? <ShieldCheck className="size-3" /> : <KeyRound className="size-3" />}
        <span>
          {verified ? 'verified' : 'stored'} · {matched.domain}
        </span>
      </div>
    )
  }, [refs, storedUrl])

  useEffect(() => {
    const wv = webviewRef.current
    if (!isWebviewConnected(wv)) return

    const onStartLoading = (): void => {
      setBrowserLoading(true, sessionId, projectId)
      setBrowserErrorInfo(null, sessionId, projectId)
    }

    const onStopLoading = (): void => {
      updateWebContentsId()
      setBrowserLoading(false, sessionId, projectId)
      updateNavState()
    }

    const onDomReady = (): void => {
      updateWebContentsId()
    }

    const onNavigate = (e: Electron.DidNavigateEvent): void => {
      internalBrowserUrlUpdateRef.current = true
      setInputUrl(e.url)
      setBrowserUrl(e.url, sessionId, projectId)
      updateNavState()
    }

    const onNavigateInPage = (e: Electron.DidNavigateInPageEvent): void => {
      internalBrowserUrlUpdateRef.current = true
      setInputUrl(e.url)
      setBrowserUrl(e.url, sessionId, projectId)
      updateNavState()
    }

    const onTitleUpdated = (e: Electron.PageTitleUpdatedEvent): void => {
      setBrowserPageTitle(e.title, sessionId, projectId)
    }

    const onFailLoad = (e: Electron.DidFailLoadEvent): void => {
      if (!e.isMainFrame || e.errorCode === -3) return
      setBrowserErrorInfo(
        { code: e.errorCode, desc: e.errorDescription, url: e.validatedURL },
        sessionId,
        projectId
      )
      setBrowserLoading(false, sessionId, projectId)
    }

    const onWillNavigate = (e: Event & { url?: string; preventDefault: () => void }): void => {
      if (!e.url || canNavigateTo(e.url)) return
      e.preventDefault()
    }

    const onNewWindow = (e: Event & { url: string; preventDefault: () => void }): void => {
      e.preventDefault()
      if (!canNavigateTo(e.url)) return
      ipcClient.invoke(IPC.SHELL_OPEN_EXTERNAL, e.url)
    }

    wv.addEventListener('did-start-loading', onStartLoading)
    wv.addEventListener('did-stop-loading', onStopLoading)
    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('did-navigate', onNavigate as EventListener)
    wv.addEventListener('did-navigate-in-page', onNavigateInPage as EventListener)
    wv.addEventListener('page-title-updated', onTitleUpdated as EventListener)
    wv.addEventListener('did-fail-load', onFailLoad as EventListener)
    wv.addEventListener('will-navigate', onWillNavigate as EventListener)
    wv.addEventListener('new-window', onNewWindow as EventListener)

    return () => {
      wv.removeEventListener('did-start-loading', onStartLoading)
      wv.removeEventListener('did-stop-loading', onStopLoading)
      wv.removeEventListener('dom-ready', onDomReady)
      wv.removeEventListener('did-navigate', onNavigate as EventListener)
      wv.removeEventListener('did-navigate-in-page', onNavigateInPage as EventListener)
      wv.removeEventListener('page-title-updated', onTitleUpdated as EventListener)
      wv.removeEventListener('did-fail-load', onFailLoad as EventListener)
      wv.removeEventListener('will-navigate', onWillNavigate as EventListener)
      wv.removeEventListener('new-window', onNewWindow as EventListener)
    }
  }, [
    canNavigateTo,
    committedUrl,
    projectId,
    sessionId,
    setBrowserLoading,
    setBrowserErrorInfo,
    setBrowserUrl,
    setBrowserPageTitle,
    updateWebContentsId,
    updateNavState
  ])

  return (
    <div className="flex h-full min-w-0 min-h-0 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex h-9 min-w-0 shrink-0 items-center gap-1 overflow-hidden border-b border-border/50 px-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => runWebviewCommand('go back', (wv) => wv.goBack())}
          disabled={!canGoBack}
          title={t('browser.back')}
        >
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => runWebviewCommand('go forward', (wv) => wv.goForward())}
          disabled={!canGoForward}
          title={t('browser.forward')}
        >
          <ArrowRight className="size-3.5" />
        </Button>
        {loading ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => runWebviewCommand('stop loading', (wv) => wv.stop())}
            title={t('browser.stop')}
          >
            <Square className="size-3" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => runWebviewCommand('refresh', (wv) => wv.reload())}
            title={t('browser.refresh')}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        )}

        <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-2 h-6">
          <Globe className="size-3 shrink-0 text-muted-foreground" />
          <input
            className="flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('browser.urlPlaceholder')}
            spellCheck={false}
          />
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={() => navigate(inputUrl)}
        >
          {t('browser.go')}
        </Button>
        {credentialBadge}
      </div>

      {/* Loading bar */}
      {loading && (
        <div className="h-0.5 w-full overflow-hidden bg-muted">
          <div className="h-full w-full animate-progress bg-primary/60" />
        </div>
      )}

      {/* 6-step login status panel (PR2-A) */}
      <LoginStepPanel />

      {/* Content */}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <LoginProgressOverlay
          open={loginOverlayStep !== null}
          step={loginOverlayStep ?? 'resolving'}
          domain={(() => {
            try {
              return new URL(storedUrl).host
            } catch {
              return null
            }
          })()}
        />
        {committedUrl && (
          <webview
            key={runtimeBrowserUserDataReuseEnabled ? 'user-browser-profile' : 'ola-profile'}
            ref={webviewRef as React.Ref<Electron.WebviewTag>}
            src={committedUrl}
            className="size-full"
            {...webviewSessionProps}
          />
        )}
        {errorInfo ? (
          <>
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-sm text-muted-foreground">
              <AlertCircle className="size-10 opacity-30" />
              <p className="font-medium">{t('rightPanel.browserLoadFailed')}</p>
              <p className="text-xs opacity-70">
                {errorInfo.desc} ({errorInfo.code})
              </p>
              <p className="max-w-[80%] truncate text-xs opacity-50">{errorInfo.url}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setBrowserErrorInfo(null, sessionId, projectId)
                  runWebviewCommand('retry load', (wv) => wv.reload())
                }}
              >
                {t('rightPanel.browserRetry')}
              </Button>
            </div>
          </>
        ) : !committedUrl ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
            <Globe className="size-8 opacity-20" />
            <span>{t('rightPanel.browserEmptyState')}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
