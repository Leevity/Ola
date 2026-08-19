import { useEffect, useState } from 'react'
import { ArrowLeft, ExternalLink, Loader2, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { useRemoteAccountStore } from '@renderer/stores/remote-account-store'
import { useUIStore } from '@renderer/stores/ui-store'

export function AccountAuthPage(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const close = useUIStore((s) => s.closeAccountAuthPage)
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
  const [captcha, setCaptcha] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!waiting) return
    const timer = window.setInterval(() => void hydrate(), 1500)
    return () => window.clearInterval(timer)
  }, [hydrate, waiting])

  useEffect(() => {
    if (waiting && account) close()
  }, [account, close, waiting])

  const openLogin = async (): Promise<void> => {
    try {
      await startBrowserLogin()
      setWaiting(true)
      toast.success(t('accountAuth.browserOpened'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('accountAuth.loginFailed'))
    }
  }

  const submitPasswordLogin = async (): Promise<void> => {
    if (!email.trim() || !password) {
      setError('请输入邮箱和密码')
      return
    }
    if (!captcha.trim()) {
      setError('请输入验证码')
      return
    }
    setError('')
    try {
      await login(email, password)
      close()
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : '登录失败')
    }
  }

  return (
    <div className="flex h-screen items-center justify-center overflow-auto bg-background px-6 py-12">
      <div className="w-full max-w-md rounded-2xl border bg-card p-8 shadow-sm">
        <Button variant="ghost" size="sm" className="mb-6 -ml-2" onClick={close}>
          <ArrowLeft className="mr-2 size-4" />
          {t('accountAuth.back')}
        </Button>
        <div className="mb-8">
          <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <ShieldCheck className="size-5" />
          </div>
          <h1 className="text-2xl font-semibold">{t('accountAuth.loginTitle')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('accountAuth.browserDescription')}
          </p>
        </div>
        <div className="mb-4 grid grid-cols-2 rounded-lg bg-muted p-1 text-sm">
          <button
            className={`rounded-md px-3 py-2 ${mode === 'browser' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
            onClick={() => setMode('browser')}
          >
            浏览器登录
          </button>
          <button
            className={`rounded-md px-3 py-2 ${mode === 'password' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
            onClick={() => setMode('password')}
          >
            账号密码
          </button>
        </div>
        {mode === 'password' ? (
          <div className="space-y-3">
            <input
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="邮箱"
            />
            <input
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="密码"
            />
            <input
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={captcha}
              onChange={(event) => setCaptcha(event.target.value)}
              placeholder="验证码"
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button
              className="w-full"
              disabled={loading}
              onClick={() => void submitPasswordLogin()}
            >
              {loading ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}登录 Ola
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
              {t('accountAuth.serverLabel')}:{' '}
              <span className="break-all text-foreground">{apiBaseUrl}</span>
            </div>
            <Button
              className="w-full"
              disabled={loading || waiting}
              onClick={() => void openLogin()}
            >
              {loading ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <ExternalLink className="mr-2 size-4" />
              )}
              {waiting ? t('accountAuth.waitingForCallback') : t('accountAuth.openBrowserLogin')}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              {t('accountAuth.callbackHint')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
