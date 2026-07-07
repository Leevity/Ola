import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, Lock } from 'lucide-react'
import { motion } from 'motion/react'
import { Button } from '@renderer/components/ui/button'
import { CapybaraSprite, type PetActivity } from '@renderer/components/pet/CapybaraSprite'
import { PET_POSE_KEYS, type PetPoseKey } from '@renderer/lib/pet/pet-pose-prompts'
import { getCombinedGrowth, getPetLevel, type Pet } from '@renderer/stores/pets-store'
import { PET_POSE_STANDARDS } from '@renderer/lib/pet/pet-standards'

interface SkinSectionProps {
  pet: Pet
}

interface PosePreview {
  id: PetPoseKey
  activity: PetActivity
  unlockLevel: number
}

const POSE_ORDER = new Map(PET_POSE_KEYS.map((key, index) => [key, index]))
const PREVIEW_POSES: PosePreview[] = PET_POSE_STANDARDS.map((standard) => ({
  id: standard.key,
  activity: (standard.key === 'held' ? 'held' : standard.key) as PetActivity,
  unlockLevel: standard.unlockLevel
})).sort(
  (a, b) =>
    a.unlockLevel - b.unlockLevel || (POSE_ORDER.get(a.id) ?? 0) - (POSE_ORDER.get(b.id) ?? 0)
)

/**
 * "Skin" tab is now an action preview for the current pet. Users can scrub
 * through poses (idle / eat / bathe / play / sleep) and watch the sprite
 * animate without leaving the dialog. AI generation is gated behind
 * `pet.isDefault` — Aniya ships with built-in art and can't be regenerated.
 */
export function SkinSection({ pet }: SkinSectionProps): React.JSX.Element {
  const { t } = useTranslation('pet')
  const [active, setActive] = useState<PosePreview>(PREVIEW_POSES[0])

  const disabled = useMemo(() => pet.isDefault, [pet.isDefault])
  const level = getPetLevel(getCombinedGrowth(pet))

  return (
    <div className="space-y-4 pt-4">
      <section className="rounded-lg border border-border/60 bg-muted/30 p-5">
        <div className="flex h-44 items-center justify-center">
          <motion.div
            key={`${pet.id}-${active}`}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.25 }}
          >
            <CapybaraSprite
              activity={active.activity}
              facing="right"
              mood={pet.mood}
              cleanliness={pet.cleanliness}
              width={140}
              skinId={pet.skinId}
            />
          </motion.div>
        </div>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          {t(`skin.preview.${active.id}`)}
        </p>
      </section>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {PREVIEW_POSES.map((pose) => (
          <Button
            key={pose.id}
            variant={active.id === pose.id ? 'default' : 'outline'}
            size="sm"
            className={`h-auto min-h-8 min-w-0 whitespace-normal px-2 py-1 text-center text-xs leading-tight ${
              pose.unlockLevel > level ? 'opacity-55' : ''
            }`}
            onClick={() => setActive(pose)}
          >
            <span className="block">{t(`poses.${pose.id}`)}</span>
            <span className="block text-[9px] opacity-70">Lv.{pose.unlockLevel}</span>
          </Button>
        ))}
      </div>

      <section className="rounded-lg border border-dashed border-border/70 bg-muted/20 p-4">
        <div className="flex items-start gap-3">
          {disabled ? (
            <Lock className="mt-0.5 size-4 text-muted-foreground" />
          ) : (
            <Sparkles className="mt-0.5 size-4 text-amber-500" />
          )}
          <div className="flex-1">
            <p className="text-sm font-medium">
              {disabled ? t('skin.aiStudio.lockedTitle') : t('skin.aiStudio.title')}
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {disabled ? t('skin.aiStudio.lockedDesc') : t('skin.aiStudio.desc')}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 h-auto min-h-7 max-w-full whitespace-normal px-3 py-1.5 text-xs leading-tight"
              disabled
              title={disabled ? t('skin.aiStudio.lockedTitle') : t('skin.aiStudio.comingSoon')}
            >
              {disabled ? t('skin.aiStudio.lockedCta') : t('skin.aiStudio.cta')}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}
