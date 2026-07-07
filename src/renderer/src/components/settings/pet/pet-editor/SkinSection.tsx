import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, Lock } from 'lucide-react'
import { motion } from 'motion/react'
import { Button } from '@renderer/components/ui/button'
import { CapybaraSprite, type PetActivity } from '@renderer/components/pet/CapybaraSprite'
import type { Pet } from '@renderer/stores/pets-store'

interface SkinSectionProps {
  pet: Pet
}

interface PosePreview {
  id: PetActivity
  labelKey: 'preview.idle' | 'preview.eat' | 'preview.bathe' | 'preview.play' | 'preview.sleep'
}

const PREVIEW_POSES: PosePreview[] = [
  { id: 'idle', labelKey: 'preview.idle' },
  { id: 'eat', labelKey: 'preview.eat' },
  { id: 'bathe', labelKey: 'preview.bathe' },
  { id: 'play', labelKey: 'preview.play' },
  { id: 'sleep', labelKey: 'preview.sleep' }
]

/**
 * "Skin" tab is now an action preview for the current pet. Users can scrub
 * through poses (idle / eat / bathe / play / sleep) and watch the sprite
 * animate without leaving the dialog. AI generation is gated behind
 * `pet.isDefault` — Aniya ships with built-in art and can't be regenerated.
 */
export function SkinSection({ pet }: SkinSectionProps): React.JSX.Element {
  const { t } = useTranslation('pet')
  const [active, setActive] = useState<PetActivity>('idle')

  const disabled = useMemo(() => pet.isDefault, [pet.isDefault])

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
              activity={active}
              facing="right"
              mood={pet.mood}
              cleanliness={pet.cleanliness}
              width={140}
            />
          </motion.div>
        </div>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          {t(`skin.preview.${active}`)}
        </p>
      </section>

      <div className="grid grid-cols-5 gap-2">
        {PREVIEW_POSES.map((pose) => (
          <Button
            key={pose.id}
            variant={active === pose.id ? 'default' : 'outline'}
            size="sm"
            className="h-8 text-xs"
            onClick={() => setActive(pose.id)}
          >
            {t(`skin.${pose.labelKey}`)}
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
              {disabled
                ? t('skin.aiStudio.lockedDesc')
                : t('skin.aiStudio.desc')}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 h-7 text-xs"
              disabled
              title={
                disabled
                  ? t('skin.aiStudio.lockedTitle')
                  : t('skin.aiStudio.comingSoon')
              }
            >
              {disabled ? t('skin.aiStudio.lockedCta') : t('skin.aiStudio.cta')}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}