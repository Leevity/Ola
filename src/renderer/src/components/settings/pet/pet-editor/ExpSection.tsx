import { useTranslation } from 'react-i18next'
import { Sparkles, Coins as TokensIcon } from 'lucide-react'
import type { Pet } from '@renderer/stores/pets-store'

interface ExpSectionProps {
  pet: Pet
}

export function ExpSection({ pet }: ExpSectionProps): React.JSX.Element {
  const { t } = useTranslation('pet')
  const { totalExp, totalTokens, log } = pet.exp

  return (
    <div className="space-y-5 pt-4">
      <section className="grid grid-cols-2 gap-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <Tile
          icon={<Sparkles className="size-3.5 text-amber-500" />}
          label={t('exp.totalExp')}
          value={totalExp.toFixed(1)}
          unit="XP"
        />
        <Tile
          icon={<TokensIcon className="size-3.5 text-sky-500" />}
          label={t('exp.totalTokens')}
          value={totalTokens.toLocaleString()}
          unit="tokens"
        />
      </section>

      <p className="text-xs leading-relaxed text-muted-foreground">{t('exp.rule')}</p>

      <section className="space-y-2 rounded-lg border border-border/60 bg-muted/30 p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{t('exp.recentLog')}</p>
          <p className="text-[10px] text-muted-foreground">
            {t('exp.logCap', { count: log.length })}
          </p>
        </div>
        {log.length === 0 ? (
          <p className="rounded-md border border-dashed border-border/70 px-3 py-3 text-xs text-muted-foreground">
            {t('exp.empty')}
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {log.slice(0, 12).map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 py-1.5 text-xs">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{entry.model}</p>
                </div>
                <div className="text-right">
                  <p className="font-medium">+{entry.exp.toFixed(2)} XP</p>
                  <p className="text-[10px] text-muted-foreground">
                    {entry.tokens.toLocaleString()} tokens
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function Tile({
  icon,
  label,
  value,
  unit
}: {
  icon: React.JSX.Element
  label: string
  value: string
  unit: string
}): React.JSX.Element {
  return (
    <div className="rounded-md bg-background/60 p-3">
      <div className="flex items-center gap-1.5">
        {icon}
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      </div>
      <p className="mt-1 flex items-baseline gap-1">
        <span className="text-base font-semibold tabular-nums">{value}</span>
        <span className="text-[10px] text-muted-foreground">{unit}</span>
      </p>
    </div>
  )
}
