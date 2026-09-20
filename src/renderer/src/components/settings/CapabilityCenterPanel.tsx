import { useTranslation } from 'react-i18next'
import { useUIStore } from '@renderer/stores/ui-store'
import { AppPluginPanel } from './AppPluginPanel'
import { ExtensionPanel } from './ExtensionPanel'
import { SettingsPageHeader } from './settings-primitives'
import { Badge } from '@renderer/components/ui/badge'
import { CAPABILITY_LIFECYCLE } from '../../../../shared/capability-lifecycle'

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

      <section className="shrink-0 rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div>
            <h2 className="text-xs font-medium">
              {t('capabilityCenter.lifecycleTitle', { defaultValue: 'Capability lifecycle' })}
            </h2>
            <p className="text-[10px] text-muted-foreground">
              {t('capabilityCenter.lifecycleDescription', {
                defaultValue:
                  'High-impact capabilities remain explicitly labelled until their release gates are complete.'
              })}
            </p>
          </div>
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {t('capabilityCenter.lifecyclePolicy', { defaultValue: 'Release policy' })}
          </Badge>
        </div>
        <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITY_LIFECYCLE.map((capability) => (
            <div
              key={capability.id}
              className="flex items-center gap-2 rounded-md border border-border/50 px-2 py-1.5"
            >
              <span className="min-w-0 flex-1 truncate text-[11px]">
                {t(`capabilityCenter.capabilities.${capability.id}`, {
                  defaultValue: capability.id
                })}
              </span>
              <Badge
                variant={capability.status === 'ga' ? 'default' : 'secondary'}
                className="h-5 px-1.5 text-[10px]"
              >
                {t(`capabilityCenter.status.${capability.status}`, {
                  defaultValue: capability.status.toUpperCase()
                })}
              </Badge>
            </div>
          ))}
        </div>
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
