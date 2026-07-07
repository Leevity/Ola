import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Coins, Utensils, Bath, Sparkles, Moon, Briefcase, GraduationCap, Play } from 'lucide-react'
import {
  getCombinedGrowth,
  getLevelProgress,
  getPetLevel,
  usePetsStore,
  type Pet,
  type PetActionName
} from '@renderer/stores/pets-store'
import { Button } from '@renderer/components/ui/button'
import { actOnDefaultPet, isDefaultPet } from '@renderer/lib/pet/default-pet-sync'
import { getNextLevelGrowth, PET_ACTION_STANDARDS } from '@renderer/lib/pet/pet-standards'
import { usePetWalletStore } from '@renderer/stores/pet-wallet-store'

interface OverviewSectionProps {
  pet: Pet
}

export function OverviewSection({ pet }: OverviewSectionProps): React.JSX.Element {
  const { t } = useTranslation('pet')
  const combinedGrowth = getCombinedGrowth(pet)
  const level = getPetLevel(combinedGrowth)
  const progress = getLevelProgress(combinedGrowth)

  const disabledAction = pet.archivedAt !== null || pet.awayTask !== null || pet.sleeping
  const actOnPet = usePetsStore((s) => s.actOnPet)
  const coins = usePetWalletStore((s) => s.coins)

  const runAction = (action: PetActionName): void => {
    const result = isDefaultPet(pet.id) ? actOnDefaultPet(action) : actOnPet(pet.id, action)
    if (!result) return
    if (result.ok) {
      toast.success(t('action.done', { defaultValue: 'Done' }))
      return
    }
    toast.warning(
      t(`action.refuse.${result.reason}`, { defaultValue: 'This action is not available now.' })
    )
  }

  return (
    <div className="space-y-5 pt-4">
      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <p className="text-sm font-medium">{t('overview.condition')}</p>
        <StatRow label={t('hud.hunger')} value={pet.hunger} barClass="bg-amber-400" />
        <StatRow label={t('hud.clean')} value={pet.cleanliness} barClass="bg-sky-400" />
        <StatRow label={t('hud.mood')} value={pet.mood} barClass="bg-pink-400" />
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">{t('overview.levelProgress')}</span>
          <span className="shrink-0 whitespace-nowrap text-right tabular-nums">
            {t('overview.growthValue', {
              current: Math.round(combinedGrowth),
              next: Math.round(getNextLevelGrowth(combinedGrowth))
            })}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-emerald-500" style={{ width: `${progress * 100}%` }} />
        </div>
      </section>

      <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
        <p className="text-sm font-medium">{t('overview.actions')}</p>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          <ActionButton
            icon={<Utensils className="size-4" />}
            label={t('action.feed')}
            cost={10}
            coins={Math.floor(coins)}
            disabled={disabledAction || pet.hunger >= 95 || coins < 10}
            onClick={() => runAction('feed')}
          />
          <ActionButton
            icon={<Bath className="size-4" />}
            label={t('action.bathe')}
            cost={6}
            coins={Math.floor(coins)}
            disabled={disabledAction || pet.cleanliness >= 95 || coins < 6}
            onClick={() => runAction('bathe')}
          />
          <ActionButton
            icon={<Sparkles className="size-4" />}
            label={t('action.soak')}
            cost={15}
            coins={Math.floor(coins)}
            disabled={
              disabledAction ||
              level < PET_ACTION_STANDARDS.soak.unlockLevel ||
              pet.cleanliness >= 95 ||
              coins < 15
            }
            onClick={() => runAction('soak')}
          />
          <ActionButton
            icon={<Play className="size-4" />}
            label={t('action.play')}
            cost={0}
            coins={Math.floor(coins)}
            disabled={disabledAction || pet.hunger < 10}
            onClick={() => runAction('play')}
          />
          <ActionButton
            icon={<Moon className="size-4" />}
            label={pet.sleeping ? t('action.wakeUp') : t('action.sleep')}
            cost={0}
            coins={Math.floor(coins)}
            disabled={pet.archivedAt !== null || pet.awayTask !== null}
            onClick={() => runAction('toggleSleep')}
          />
          <ActionButton
            icon={<Briefcase className="size-4" />}
            label={t('action.work')}
            cost={0}
            coins={Math.floor(coins)}
            disabled={
              disabledAction || level < PET_ACTION_STANDARDS.work.unlockLevel || pet.hunger < 20
            }
            onClick={() => runAction('startWork')}
          />
          <ActionButton
            icon={<GraduationCap className="size-4" />}
            label={t('action.study')}
            cost={20}
            coins={Math.floor(coins)}
            disabled={
              disabledAction ||
              level < PET_ACTION_STANDARDS.study.unlockLevel ||
              coins < 20 ||
              pet.hunger < 20
            }
            onClick={() => runAction('startStudy')}
          />
        </div>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Coins className="size-3 text-amber-500" />
          {t('overview.coins', { coins: Math.floor(coins) })}
        </p>
        {pet.awayTask ? (
          <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            {pet.awayTask.kind === 'work'
              ? t('overview.working', {
                  minutes: Math.max(0, Math.ceil((pet.awayTask.endsAt - Date.now()) / 60000))
                })
              : t('overview.studying', {
                  minutes: Math.max(0, Math.ceil((pet.awayTask.endsAt - Date.now()) / 60000))
                })}
          </p>
        ) : null}
      </section>

      <p className="text-xs leading-relaxed text-muted-foreground">{t('panel.hint')}</p>
    </div>
  )
}

function StatRow({
  label,
  value,
  barClass
}: {
  label: string
  value: number
  barClass: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 text-xs text-muted-foreground">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full ${barClass}`}
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      </div>
      <span className="w-10 text-right text-xs tabular-nums">{Math.round(value)}</span>
    </div>
  )
}

function ActionButton({
  icon,
  label,
  cost,
  coins,
  disabled,
  onClick
}: {
  icon: React.ReactNode
  label: string
  cost: number
  coins: number
  disabled: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <Button
      variant="outline"
      className="h-auto flex-col gap-1 py-2 text-xs"
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
      {cost > 0 ? (
        <span className={`text-[10px] ${coins >= cost ? 'text-emerald-500' : 'text-rose-400'}`}>
          {cost} 🪙
        </span>
      ) : null}
    </Button>
  )
}
