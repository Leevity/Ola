import { useTranslation } from 'react-i18next'
import { useUIStore } from '@renderer/stores/ui-store'
import { AppPluginPanel } from './AppPluginPanel'
import { ExtensionPanel } from './ExtensionPanel'
import { SettingsPageHeader } from './settings-primitives'

export function CapabilityCenterPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const setSettingsTab = useUIStore((state) => state.setSettingsTab)
  const settingsTab = useUIStore((state) => state.settingsTab)

  const activeTab = settingsTab === 'extension' ? 'custom' : 'builtin'
  const tabs = [
    {
      id: 'builtin' as const,
      label: t('plugin.defaultPlugins')
    },
    {
      id: 'custom' as const,
      label: t('plugin.customPlugins')
    }
  ]

  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      <section aria-labelledby="capability-center-title" className="shrink-0">
        <SettingsPageHeader
          title={t('plugin.title')}
          description={t('capabilityCenter.description')}
        />
      </section>

      <div
        className="flex min-h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/60"
        role="tablist"
        aria-label={t('plugin.title')}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setSettingsTab(tab.id === 'custom' ? 'extension' : 'plugin')}
            className={`shrink-0 border-b-2 px-3 py-2.5 text-sm transition-colors ${
              activeTab === tab.id
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 min-w-0 flex-1">
        {activeTab === 'custom' ? <ExtensionPanel embedded /> : <AppPluginPanel embedded />}
      </div>
    </div>
  )
}
