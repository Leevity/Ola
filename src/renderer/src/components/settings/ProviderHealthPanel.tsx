import { useEffect } from 'react'
import { RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useProviderHealthStore } from '@renderer/stores/provider-health-store'

export function ProviderHealthPanel(): React.JSX.Element {
  const providers = useProviderHealthStore((state) => state.providers)
  const loading = useProviderHealthStore((state) => state.loading)
  const load = useProviderHealthStore((state) => state.load)
  const reset = useProviderHealthStore((state) => state.reset)

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 10_000)
    return () => window.clearInterval(timer)
  }, [load])

  return (
    <section className="border-b bg-muted/10 px-4 py-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-medium">Provider health</h3>
          <p className="text-[10px] text-muted-foreground">
            Temporary failures are tracked without exposing request credentials.
          </p>
        </div>
        <Button variant="ghost" size="icon" className="size-7" onClick={() => void load()}>
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      {providers.length > 0 ? (
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {providers.map((provider) => (
            <div
              key={provider.providerKey}
              className="flex items-center gap-2 rounded-md border p-2"
            >
              <span
                className={`size-2 rounded-full ${
                  provider.status === 'healthy'
                    ? 'bg-emerald-500'
                    : provider.status === 'degraded'
                      ? 'bg-amber-500'
                      : 'bg-red-500'
                }`}
              />
              <span className="min-w-0 flex-1 truncate text-[11px]">{provider.providerKey}</span>
              <span className="text-[10px] text-muted-foreground">
                {provider.successfulRequests}/{provider.totalRequests}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                title="Reset health"
                onClick={() => void reset(provider.providerKey)}
              >
                <RotateCcw className="size-3" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}
