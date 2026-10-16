import { useState } from 'react'
import { ArrowRight, Laptop, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AccountAuthPage } from '@renderer/components/account/AccountAuthPage'
import { OlaBrand } from '@renderer/components/brand/OlaBrand'
import { Button } from '@renderer/components/ui/button'
import { useSettingsStore } from '@renderer/stores/settings-store'

export function FirstRunAccessPage(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const [signingIn, setSigningIn] = useState(false)
  const choose = (mode: 'account' | 'local'): void => {
    useSettingsStore.getState().updateSettings({ onboardingAccessMode: mode })
  }
  if (signingIn) {
    return (
      <AccountAuthPage onBack={() => setSigningIn(false)} onSignedIn={() => choose('account')} />
    )
  }
  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex h-20 items-center px-8">
        <OlaBrand />
      </header>
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-8 pb-20">
        <p className="mb-4 text-sm font-medium text-primary">{t('accountAuth.workspaceEyebrow')}</p>
        <h1 className="text-4xl leading-tight font-semibold tracking-tight">
          {t('firstRun.title')}
        </h1>
        <p className="mt-5 mb-8 text-base leading-7 text-muted-foreground">
          {t('firstRun.description')}
        </p>
        <section className="rounded-xl border bg-card p-6" aria-label={t('firstRun.accountTitle')}>
          <ShieldCheck className="mb-4 size-6 text-primary" aria-hidden="true" />
          <h2 className="text-lg font-semibold">{t('firstRun.accountTitle')}</h2>
          <p className="mt-2 mb-6 text-sm leading-6 text-muted-foreground">
            {t('firstRun.accountDescription')}
          </p>
          <Button className="h-11 w-full" onClick={() => setSigningIn(true)}>
            {t('firstRun.signIn')}
            <ArrowRight className="ml-2 size-4" />
          </Button>
        </section>
        <Button className="mt-4 h-11 w-full" variant="outline" onClick={() => choose('local')}>
          <Laptop className="mr-2 size-4" />
          {t('firstRun.local')}
        </Button>
        <p className="mt-3 text-center text-xs leading-5 text-muted-foreground">
          {t('firstRun.localDescription')}
        </p>
      </div>
    </main>
  )
}
