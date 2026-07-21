import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Clock3, RefreshCw, ShieldAlert, Workflow } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { useChatStore } from '@renderer/stores/chat-store'
import { useHooksStore } from '@renderer/stores/hooks-store'

const shortHash = (value: string): string => value.slice(0, 12)

export function HooksPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const activeSession = useChatStore((state) =>
    state.sessions.find((session) => session.id === state.activeSessionId)
  )
  const projectPath = activeSession?.workingFolder
  const { hooks, history, loading, error, refresh, trust, revoke } = useHooksStore()

  useEffect(() => {
    void refresh(projectPath)
  }, [projectPath, refresh])

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('hooks.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('hooks.subtitle')}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => void refresh(projectPath)}
        >
          <RefreshCw className={`mr-2 size-4 ${loading ? 'animate-spin' : ''}`} />
          {t('hooks.refresh')}
        </Button>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}
      <div className="rounded-xl border bg-muted/20 p-3 text-sm text-muted-foreground">
        {t('hooks.securityNotice')}
      </div>

      <section className="space-y-3">
        <h2 className="font-medium">{t('hooks.configured')}</h2>
        {!loading && hooks.length === 0 && (
          <p className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
            {t('hooks.empty')}
          </p>
        )}
        {hooks.map((hook) => {
          const lastRun = history.find(
            (run) => run.hookId === hook.id && run.source === hook.source
          )
          return (
            <article
              key={`${hook.source}:${hook.id}`}
              className="rounded-2xl border bg-card p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Workflow className="size-4" />
                    <h3 className="font-medium">{hook.id}</h3>
                    <Badge variant="secondary">{t(`hooks.source.${hook.source}`)}</Badge>
                    <Badge variant="outline">{hook.event}</Badge>
                  </div>
                  <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                    {hook.executablePath} {hook.args.join(' ')}
                  </p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    SHA-256 {shortHash(hook.executableHash)} · {t('hooks.configHash')}{' '}
                    {shortHash(hook.configHash)}
                  </p>
                  {Object.entries(hook.artifactHashes).map(([path, digest]) => (
                    <p
                      key={path}
                      className="mt-1 break-all font-mono text-xs text-muted-foreground"
                    >
                      {path} · SHA-256 {shortHash(digest)}
                    </p>
                  ))}
                  {lastRun && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t('hooks.history')}: {new Date(lastRun.startedAt).toLocaleString()} ·{' '}
                      {t(`hooks.status.${lastRun.status}`)}
                    </p>
                  )}
                </div>
                {hook.trustState === 'trusted' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void revoke(hook.trustKey, projectPath)}
                  >
                    <CheckCircle2 className="mr-2 size-4 text-emerald-500" />
                    {t('hooks.revoke')}
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => void trust(hook.trustKey, projectPath)}>
                    <ShieldAlert className="mr-2 size-4" />
                    {t('hooks.reviewAndTrust')}
                  </Button>
                )}
              </div>
            </article>
          )
        })}
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">{t('hooks.history')}</h2>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('hooks.noHistory')}</p>
        ) : (
          history.slice(0, 50).map((run) => (
            <article key={run.id} className="rounded-xl border bg-card p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Clock3 className="size-4" />
                <span className="font-medium">{run.hookId}</span>
                <Badge variant="outline">{run.event}</Badge>
                <Badge variant={run.status === 'completed' ? 'secondary' : 'destructive'}>
                  {t(`hooks.status.${run.status}`)}
                </Badge>
                <span className="text-muted-foreground">{run.durationMs} ms</span>
              </div>
              {run.stdoutSummary && (
                <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                  {run.stdoutSummary}
                </pre>
              )}
              {run.stderrSummary && (
                <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-destructive/5 p-2 text-xs text-destructive">
                  {run.stderrSummary}
                </pre>
              )}
            </article>
          ))
        )}
      </section>
    </div>
  )
}
