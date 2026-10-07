import { useEffect } from 'react'
import { CircleAlert, CircleHelp, RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useProviderHealthStore } from '@renderer/stores/provider-health-store'
import { useTranslation } from 'react-i18next'

export function ProviderHealthPanel(): React.JSX.Element {
  const { t, i18n } = useTranslation('settings')
  const providers = useProviderHealthStore((state) => state.providers)
  const loading = useProviderHealthStore((state) => state.loading)
  const loadedAt = useProviderHealthStore((state) => state.loadedAt)
  const loadError = useProviderHealthStore((state) => state.loadError)
  const load = useProviderHealthStore((state) => state.load)
  const reset = useProviderHealthStore((state) => state.reset)

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 30_000)
    return () => window.clearInterval(timer)
  }, [load])

  return (
    <section className="border-b bg-muted/10 px-4 py-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{t('providerHealth.title')}</h3>
          <p className="text-[0.8125rem] text-muted-foreground">
            {t('providerHealth.description')}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground" aria-live="polite">
            {loadError
              ? t('providerHealth.loadFailed')
              : loadedAt
                ? t('providerHealth.lastChecked', {
                    time: new Intl.DateTimeFormat(i18n.language, {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit'
                    }).format(loadedAt)
                  })
                : t('providerHealth.notChecked')}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t('providerHealth.refresh')}
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      {loadError ? (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-[0.8125rem] text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{t('providerHealth.retryHint')}</span>
        </div>
      ) : null}
      {providers.length > 0 ? (
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {providers.map((provider) => (
            <div
              key={provider.providerKey}
              className="flex items-center gap-2 rounded-md border p-2"
            >
              <span
                aria-hidden="true"
                className={`size-2 rounded-full ${
                  provider.status === 'healthy'
                    ? 'bg-emerald-500'
                    : provider.status === 'degraded'
                      ? 'bg-amber-500'
                      : 'bg-red-500'
                }`}
              />
              <span className="min-w-0 flex-1 truncate text-[0.8125rem]">
                {provider.providerKey}
              </span>
              <span
                className="text-xs text-muted-foreground"
                title={t('providerHealth.requestCounts')}
              >
                {provider.successfulRequests}/{provider.totalRequests}
              </span>
              <span
                className={`text-[0.8125rem] ${
                  provider.status === 'healthy'
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : provider.status === 'degraded'
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-destructive'
                }`}
              >
                {provider.status === 'healthy'
                  ? t('providerHealth.status.healthy')
                  : provider.status === 'degraded'
                    ? t('providerHealth.status.degraded')
                    : t('providerHealth.status.down')}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={t('providerHealth.reset', { provider: provider.providerKey })}
                onClick={() => void reset(provider.providerKey)}
              >
                <RotateCcw className="size-3" />
              </Button>
            </div>
          ))}
        </div>
      ) : loadedAt && !loadError ? (
        <div className="mt-2 flex items-center gap-2 rounded-md border p-2 text-[0.8125rem] text-muted-foreground">
          <CircleHelp className="size-4 shrink-0" />
          {t('providerHealth.empty')}
        </div>
      ) : null}
    </section>
  )
}
