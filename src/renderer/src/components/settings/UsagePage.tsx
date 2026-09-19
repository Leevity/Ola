import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { useUIStore } from '@renderer/stores/ui-store'
import { AnalyticsPanel } from './SettingsPage'
import { SETTINGS_PANEL_CLASS } from './settings-primitives'

export function UsagePage(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const navigateToHome = useUIStore((state) => state.navigateToHome)
  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/10">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-4">
        <Button variant="ghost" size="icon" onClick={navigateToHome} aria-label={t('page.back')}>
          <ArrowLeft className="size-4" />
        </Button>
      </header>
      <main className={`${SETTINGS_PANEL_CLASS} min-h-0 flex-1 overflow-y-auto px-6 py-6`}>
        <AnalyticsPanel />
      </main>
    </div>
  )
}
