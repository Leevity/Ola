import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import {
  Bath,
  Briefcase,
  GraduationCap,
  Moon,
  Play,
  Sparkles,
  Utensils,
  EyeOff
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import {
  BATHE_COST,
  FEED_COST,
  SOAK_COST,
  STUDY_COST,
  PET_DESKTOP_LIMIT,
  usePetsStore,
  type Pet,
  type PetActionName
} from '@renderer/stores/pets-store'
import { usePetWalletStore } from '@renderer/stores/pet-wallet-store'
import { CapybaraSprite, type PetActivity } from './CapybaraSprite'

const PET_WIDTH = 132
const GROUND_PADDING = 12

interface MultiPetDesktopViewProps {
  pets: Pet[]
}

type TransientActivity = Extract<PetActivity, 'eat' | 'bathe' | 'soak' | 'play' | 'sleep'>

export function MultiPetDesktopView({ pets }: MultiPetDesktopViewProps): React.JSX.Element {
  const sorted = useMemo(() => pets.slice(0, PET_DESKTOP_LIMIT), [pets])

  return (
    <div className="fixed inset-0 bg-transparent">
      {sorted.map((pet, index) => (
        <DesktopPet key={pet.id} pet={pet} index={index} total={sorted.length} />
      ))}
    </div>
  )
}

function DesktopPet({
  pet,
  index,
  total
}: {
  pet: Pet
  index: number
  total: number
}): React.JSX.Element {
  const { t } = useTranslation('pet')
  const actOnPet = usePetsStore((s) => s.actOnPet)
  const coins = usePetWalletStore((s) => s.coins)
  const [hover, setHover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [activity, setActivity] = useState<PetActivity>(pet.sleeping ? 'sleep' : 'idle')
  const fallbackX = Math.max(24, ((index + 1) * window.innerWidth) / (total + 1) - PET_WIDTH / 2)
  const [x, setX] = useState(pet.position?.x ?? fallbackX)
  const [dragStart, setDragStart] = useState<{
    pointerId: number
    startX: number
    x: number
  } | null>(null)

  const run = (action: PetActionName, pose: TransientActivity): void => {
    setMenuOpen(false)
    const result = actOnPet(pet.id, action)
    if (!result.ok) return
    setActivity(action === 'toggleSleep' && !pet.sleeping ? 'sleep' : pose)
    window.setTimeout(() => setActivity('idle'), action === 'toggleSleep' ? 1200 : 2600)
  }

  const pointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragStart({ pointerId: e.pointerId, startX: e.clientX, x })
  }

  const pointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragStart || dragStart.pointerId !== e.pointerId) return
    const nextX = Math.max(
      0,
      Math.min(window.innerWidth - PET_WIDTH, dragStart.x + e.clientX - dragStart.startX)
    )
    setX(nextX)
  }

  const pointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragStart || dragStart.pointerId !== e.pointerId) return
    setDragStart(null)
    usePetsStore.getState().updatePet(pet.id, { position: { x, y: 0 } })
  }

  return (
    <motion.div
      className="absolute"
      style={{ left: x, bottom: GROUND_PADDING, width: PET_WIDTH }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenuOpen((value) => !value)
      }}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
    >
      {hover ? (
        <div className="absolute bottom-[118px] left-1/2 z-10 flex -translate-x-1/2 gap-1 rounded-full border border-border/60 bg-background/95 p-1 shadow-lg backdrop-blur">
          <QuickAction
            title={t('action.feed')}
            disabled={pet.hunger >= 95 || coins < FEED_COST || pet.sleeping || !!pet.awayTask}
            onClick={(e) => {
              e.stopPropagation()
              run('feed', 'eat')
            }}
          >
            <Utensils className="size-3.5" />
          </QuickAction>
          <QuickAction
            title={t('action.bathe')}
            disabled={pet.cleanliness >= 95 || coins < BATHE_COST || pet.sleeping || !!pet.awayTask}
            onClick={(e) => {
              e.stopPropagation()
              run('bathe', 'bathe')
            }}
          >
            <Bath className="size-3.5" />
          </QuickAction>
          <QuickAction
            title={t('action.play')}
            disabled={pet.hunger < 10 || pet.sleeping || !!pet.awayTask}
            onClick={(e) => {
              e.stopPropagation()
              run('play', 'play')
            }}
          >
            <Play className="size-3.5" />
          </QuickAction>
          <QuickAction
            title={pet.sleeping ? t('action.wakeUp') : t('action.sleep')}
            disabled={!!pet.awayTask}
            onClick={(e) => {
              e.stopPropagation()
              run('toggleSleep', 'sleep')
            }}
          >
            <Moon className="size-3.5" />
          </QuickAction>
        </div>
      ) : null}
      {hover ? (
        <div className="absolute bottom-[92px] left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-background/90 px-2 py-1 text-[11px] shadow">
          {pet.name} · {Math.floor(coins)} 🪙
        </div>
      ) : null}
      {menuOpen ? (
        <div className="absolute bottom-[122px] left-1/2 z-20 w-44 -translate-x-1/2 rounded-lg border border-border/60 bg-background/95 p-1 text-xs shadow-xl backdrop-blur">
          <MenuAction
            icon={<Utensils className="size-3.5" />}
            label={t('menu.feed')}
            disabled={pet.hunger >= 95 || coins < FEED_COST || pet.sleeping || !!pet.awayTask}
            onClick={() => run('feed', 'eat')}
          />
          <MenuAction
            icon={<Bath className="size-3.5" />}
            label={t('menu.bathe')}
            disabled={pet.cleanliness >= 95 || coins < BATHE_COST || pet.sleeping || !!pet.awayTask}
            onClick={() => run('bathe', 'bathe')}
          />
          <MenuAction
            icon={<Sparkles className="size-3.5" />}
            label={t('menu.soak')}
            disabled={pet.cleanliness >= 95 || coins < SOAK_COST || pet.sleeping || !!pet.awayTask}
            onClick={() => run('soak', 'soak')}
          />
          <MenuAction
            icon={<Play className="size-3.5" />}
            label={t('menu.play')}
            disabled={pet.hunger < 10 || pet.sleeping || !!pet.awayTask}
            onClick={() => run('play', 'play')}
          />
          <MenuAction
            icon={<Moon className="size-3.5" />}
            label={pet.sleeping ? t('menu.wake') : t('menu.sleep')}
            disabled={!!pet.awayTask}
            onClick={() => run('toggleSleep', 'sleep')}
          />
          <MenuAction
            icon={<Briefcase className="size-3.5" />}
            label={t('menu.work')}
            disabled={pet.hunger < 20 || pet.sleeping || !!pet.awayTask}
            onClick={() => run('startWork', 'play')}
          />
          <MenuAction
            icon={<GraduationCap className="size-3.5" />}
            label={t('menu.study')}
            disabled={pet.hunger < 20 || coins < STUDY_COST || pet.sleeping || !!pet.awayTask}
            onClick={() => run('startStudy', 'play')}
          />
          <MenuAction
            icon={<EyeOff className="size-3.5" />}
            label={t('menu.hide')}
            disabled={false}
            onClick={() => usePetsStore.getState().setEnabled(pet.id, false)}
          />
        </div>
      ) : null}
      <CapybaraSprite
        activity={pet.sleeping ? 'sleep' : activity}
        facing="right"
        mood={pet.mood}
        cleanliness={pet.cleanliness}
        width={PET_WIDTH}
        skinId={pet.skinId}
      />
    </motion.div>
  )
}

function MenuAction({
  icon,
  label,
  disabled,
  onClick
}: {
  icon: React.ReactNode
  label: string
  disabled: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

function QuickAction({
  children,
  disabled,
  title,
  onClick
}: {
  children: React.ReactNode
  disabled: boolean
  title: string
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="size-7 rounded-full"
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}
