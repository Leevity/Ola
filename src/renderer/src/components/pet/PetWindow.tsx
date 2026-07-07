import { useEffect, useState } from 'react'
import i18n from '../../locales'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { usePetSkinStore } from '@renderer/stores/pet-skin-store'
import { usePetsStore, type Pet } from '@renderer/stores/pets-store'
import { runPetMigration } from '@renderer/lib/pet/pet-migrate'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { ThemeProvider } from '../theme-provider'
import { ErrorBoundary } from '../error-boundary'
import { MultiPetDesktopView } from './MultiPetDesktopView'

/**
 * Standalone root for the transparent desktop-pet window (?appView=pet).
 * Multi-pet: the on-desktop pet is whichever one has `activeOnDesktopId`.
 * Its state is mirrored into the legacy single-pet stores so PetView (built
 * before the redesign) keeps working without touching its 1400-line body.
 */
export function PetWindow(): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme)
  const language = useSettingsStore((s) => s.language)

  // Force a light surface so the capybara sprite is always readable,
  // regardless of the user's app-wide theme preference.
  useEffect(() => {
    document.documentElement.classList.remove('dark')
    document.documentElement.classList.add('light')
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    document.body.style.colorScheme = 'light'
    const root = document.getElementById('root')
    if (root) {
      root.style.background = 'transparent'
      root.style.colorScheme = 'light'
    }
  }, [])
  // Render every enabled, non-archived pet on the desktop. If none are
  // explicitly active, fall back to the first enabled pet — the user has
  // already opted in by flipping its card switch.
  const desktopPets = usePetsStore((s) =>
    s.enabledIds
      .map((id) => s.pets.find((pet) => pet.id === id && pet.archivedAt === null && pet.enabled))
      .filter((pet): pet is Pet => Boolean(pet))
  )

  const [ready, setReady] = useState(false)

  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    const root = document.getElementById('root')
    if (root) root.style.background = 'transparent'
  }, [])

  useEffect(() => {
    if (i18n.language !== language) {
      void i18n.changeLanguage(language)
    }
  }, [language])

  useEffect(() => {
    // Pull the latest persisted pets collection from the main process
    // before rendering so the desktop shows whatever the user just enabled.
    void (async () => {
      try {
        const raw = await ipcClient.invoke('pet:collection:get')
        const payload = raw as {
          state?: {
            pets?: unknown[]
            enabledIds?: string[]
            activePetId?: string | null
            activeOnDesktopId?: string | null
          }
        } | null
        const state = payload?.state
        if (state && Array.isArray(state.pets)) {
          usePetsStore.setState({
            pets: state.pets as Pet[],
            enabledIds: Array.isArray(state.enabledIds) ? state.enabledIds : [],
            activePetId: state.activePetId ?? null,
            activeOnDesktopId: state.activeOnDesktopId ?? null
          })
        }
      } catch {
        // ignore
      } finally {
        setReady(true)
      }
    })()

    void runPetMigration()
      .catch(() => undefined)
      .then(() => {
        try {
          usePetsStore.persist.rehydrate()
        } catch {
          // Tolerate already-hydrated stores; persist throws when called
          // outside the React tree in some setups.
        }
        void usePetSkinStore.getState().scan()

        // Heal stale focus: a previous session may have persisted an
        // `activeOnDesktopId` whose pet is no longer enabled.
        const s = usePetsStore.getState()
        if (s.activeOnDesktopId && !s.enabledIds.includes(s.activeOnDesktopId)) {
          s.setActiveOnDesktop(null)
        }
      })
  }, [])

  useEffect(() => {
    // Single-pet mode keeps click-through; multi-pet mode allows the user
    // to hover over each sprite independently.
    void ipcClient.invoke('pet-window:set-ignore-mouse', {
      ignore: desktopPets.length <= 1
    })
  }, [desktopPets.length])

  // When the BrowserWindow is closed via tray/menu/external path, just let
// the per-card store state stay as-is — the next time the user opens a
// card switch, `pet-window:open` will be invoked from PetListTab.

  // Apply cross-window broadcasts (settings → pet-window).
  useEffect(() => {
    return ipcClient.on('pet:sync-event', (payload) => {
      const event = payload as { kind?: string; payload?: unknown } | null
      if (event?.kind === 'skin') {
        const detail = event.payload as { activeSkinId?: string | null; petId?: string } | undefined
        if (detail && 'activeSkinId' in detail) {
          usePetSkinStore.setState({ activeSkinId: detail.activeSkinId ?? null })
          void usePetSkinStore.getState().scan()
        } else {
          void Promise.resolve(usePetSkinStore.persist.rehydrate()).then(() =>
            usePetSkinStore.getState().scan()
          )
        }
      } else if (event?.kind === 'pets') {
        // Settings window updated the pets collection: pull the fresh
        // snapshot so the desktop pet reflects the new enabled state.
        void ipcClient
          .invoke('pet:collection:get')
          .then((raw) => {
            const payload = raw as {
              state?: {
                pets?: unknown[]
                enabledIds?: string[]
                activePetId?: string | null
                activeOnDesktopId?: string | null
              }
            } | null
            const state = payload?.state
            if (!state || !Array.isArray(state.pets)) return
            usePetsStore.setState({
              pets: state.pets as Pet[],
              enabledIds: Array.isArray(state.enabledIds) ? state.enabledIds : [],
              activePetId: state.activePetId ?? null,
              activeOnDesktopId: state.activeOnDesktopId ?? null
            })
          })
          .catch(() => undefined)
      }
    })
  }, [])

  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme={theme}>
        {ready && desktopPets.length > 0 ? (
          <MultiPetDesktopView pets={desktopPets} />
        ) : ready && desktopPets.length === 0 ? (
          <div className="flex h-screen w-screen items-center justify-center p-6 text-center text-sm text-muted-foreground">
            <p>暂无可显示的桌面伙伴。请在主窗口设置中开启某位伙伴的卡片开关。</p>
          </div>
        ) : null}
      </ThemeProvider>
    </ErrorBoundary>
  )
}
