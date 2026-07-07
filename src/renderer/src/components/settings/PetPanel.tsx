import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { PetListTab } from './pet/PetListTab'
import { runPetMigration } from '@renderer/lib/pet/pet-migrate'
import {
  installDefaultPetSync,
  syncLegacyPetToDefaultPet
} from '@renderer/lib/pet/default-pet-sync'
import { usePetsStore } from '@renderer/stores/pets-store'

/**
 * Top-level "Desktop Pet" panel. The 6-tab layout has been collapsed to a
 * single list view per the multi-pet redesign: each card opens an editor
 * dialog with all five sub-sections (overview / skin / agent / exp /
 * settings) inside.
 */
export function PetPanel(): React.JSX.Element {
  const { t } = useTranslation('pet')

  // Pull the legacy single-pet storage into the new pets collection the
  // first time this panel mounts. Idempotent: the marker key guards against
  // running twice.
  useEffect(() => {
    void runPetMigration()
      .catch(() => undefined)
      .then(async () => {
        await Promise.resolve(usePetsStore.persist.rehydrate())
        syncLegacyPetToDefaultPet()
        // Heal stale focus (see PetWindow mount for the same logic).
        const s = usePetsStore.getState()
        if (s.activeOnDesktopId && !s.enabledIds.includes(s.activeOnDesktopId)) {
          s.setActiveOnDesktop(null)
        }
      })
  }, [])

  useEffect(() => installDefaultPetSync(), [])

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <PetListTab />
    </div>
  )
}
