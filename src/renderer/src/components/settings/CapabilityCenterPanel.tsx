import { useTranslation } from 'react-i18next'
import { useUIStore } from '@renderer/stores/ui-store'
import { AppPluginPanel } from './AppPluginPanel'
import { ExtensionPanel } from './ExtensionPanel'

export function CapabilityCenterPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const setSettingsTab = useUIStore((state) => state.setSettingsTab)
  const settingsTab = useUIStore((state) => state.settingsTab)

  const activeTab = settingsTab === 'extension' ? 'custom' : 'builtin'
  const tabs = [
    {
      id: 'builtin' as const,
      label: t('plugin.defaultPlugins', { defaultValue: '默认插件' })
    },
    {
      id: 'custom' as const,
      label: t('plugin.customPlugins', { defaultValue: '自定义插件' })
    }
  ]

  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      <section aria-labelledby="capability-center-title" className="shrink-0">
        <h2 id="capability-center-title" className="text-lg font-semibold">
          {t('plugin.title')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('capabilityCenter.description', {
            defaultValue: '管理 Ola 的默认插件和自定义插件能力。'
          })}
        </p>
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
        {activeTab === 'custom' ? <ExtensionPanel /> : <AppPluginPanel />}
      </div>
    </div>
  )
}
