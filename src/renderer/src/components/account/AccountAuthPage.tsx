import { useEffect, useState } from 'react'
import { ArrowLeft, ExternalLink, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { OlaBrand } from '@renderer/components/brand/OlaBrand'
import { useRemoteAccountStore } from '@renderer/stores/remote-account-store'
import { useUIStore } from '@renderer/stores/ui-store'

export function AccountAuthPage({
  onBack,
  onSignedIn
}: { onBack?: () => void; onSignedIn?: () => void } = {}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const close = useUIStore((s) => s.closeAccountAuthPage)
  const returnToApp = onBack ?? close
  const complete = onSignedIn ?? close
  const apiBaseUrl = useRemoteAccountStore((s) => s.apiBaseUrl)
  const startBrowserLogin = useRemoteAccountStore((s) => s.startBrowserLogin)
  const login = useRemoteAccountStore((s) => s.login)
  const hydrate = useRemoteAccountStore((s) => s.hydrate)
  const account = useRemoteAccountStore((s) => s.account)
  const loading = useRemoteAccountStore((s) => s.loading)
  const [waiting, setWaiting] = useState(false)
  const [mode, setMode] = useState<'browser' | 'password'>('browser')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!waiting) return
    const timer = window.setInterval(() => void hydrate(), 1500)
    return () => window.clearInterval(timer)
  }, [hydrate, waiting])

  useEffect(() => {
    if (waiting && account) complete()
  }, [account, complete, waiting])

  const openLogin = async (): Promise<void> => {
    setError('')
    try {
      await startBrowserLogin()
      setWaiting(true)
      toast.success(t('accountAuth.browserOpened'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('accountAuth.loginFailed'))
    }
  }

  const submitPasswordLogin = async (): Promise<void> => {
    if (!email.trim() || !password) {
      setError(t('accountAuth.missingCredentials'))
      return
    }
    setError('')
    try {
      await login(email, password)
      complete()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('accountAuth.loginFailed'))
    }
  }

  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex h-20 shrink-0 items-center justify-between px-8">
        <OlaBrand />
        <Button variant="ghost" size="sm" onClick={returnToApp}>
          <ArrowLeft className="mr-2 size-4" />
          {t('accountAuth.back')}
        </Button>
      </header>
      <div className="mx-auto flex w-full max-w-[1080px] flex-1 items-center gap-20 px-8 py-12 max-[800px]:flex-col max-[800px]:items-stretch max-[800px]:gap-8">
        <section className="min-w-0 flex-1">
          <p className="mb-4 text-sm font-medium text-primary">
            {t('accountAuth.workspaceEyebrow')}
          </p>
          <h1 className="text-4xl leading-tight font-semibold tracking-tight">
            {t('accountAuth.workspaceHeading')}
          </h1>
          <p className="mt-5 max-w-md text-base leading-7 text-muted-foreground">
            {t('accountAuth.workspaceDescription')}
          </p>
        </section>
        <section
          className="w-full max-w-[420px] shrink-0 rounded-xl border bg-card p-8 max-[800px]:max-w-none"
          aria-labelledby="ola-sign-in-title"
        >
          <h2 id="ola-sign-in-title" className="text-2xl font-semibold">
            {t('accountAuth.loginTitle')}
          </h2>
          <p className="mt-3 mb-7 text-sm leading-6 text-muted-foreground">
            {mode === 'browser'
              ? t('accountAuth.browserDescription')
              : t('accountAuth.passwordDescription')}
          </p>
          {mode === 'password' ? (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault()
                void submitPasswordLogin()
              }}
            >
              <label className="block text-sm">
                {t('accountAuth.email')}
                <Input
                  className="mt-2 h-11"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  disabled={loading}
                />
              </label>
              <label className="block text-sm">
                {t('accountAuth.password')}
                <Input
                  className="mt-2 h-11"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  disabled={loading}
                />
              </label>
              <Button className="h-11 w-full" type="submit" disabled={loading}>
                {loading && <Loader2 className="mr-2 size-4 animate-spin" />}
                {t('accountAuth.login')}
              </Button>
            </form>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
                {t('accountAuth.serverLabel')}:{' '}
                <span className="break-all text-foreground">{apiBaseUrl}</span>
              </div>
              <Button
                className="h-11 w-full"
                disabled={loading || waiting}
                onClick={() => void openLogin()}
              >
                {loading || waiting ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <ExternalLink className="mr-2 size-4" />
                )}
                <span aria-live="polite">
                  {waiting
                    ? t('accountAuth.waitingForCallback')
                    : t('accountAuth.openBrowserLogin')}
                </span>
              </Button>
              <p className="text-center text-sm leading-6 text-muted-foreground">
                {t('accountAuth.callbackHint')}
              </p>
              {waiting && (
                <Button
                  variant="ghost"
                  className="w-full"
                  disabled={loading}
                  onClick={() => void openLogin()}
                >
                  {t('accountAuth.retryBrowser')}
                </Button>
              )}
            </div>
          )}
          {error && (
            <p
              className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
          {!waiting && (
            <Button
              variant="link"
              className="mt-5 w-full"
              disabled={loading}
              onClick={() => {
                setMode(mode === 'browser' ? 'password' : 'browser')
                setError('')
              }}
            >
              {mode === 'browser' ? t('accountAuth.otherSignIn') : t('accountAuth.backToBrowser')}
            </Button>
          )}
        </section>
      </div>
    </main>
  )
}
