import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useUIStore } from '@renderer/stores/ui-store'
import { AppPluginPanel } from './AppPluginPanel'
import { ExtensionPanel } from './ExtensionPanel'
import { SettingsPageHeader } from './settings-primitives'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { CAPABILITY_LIFECYCLE } from '../../../../shared/capability-lifecycle'
import { CapabilityHealthSummary } from './CapabilityHealthSummary'

export function CapabilityCenterPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const setSettingsTab = useUIStore((state) => state.setSettingsTab)
  const settingsTab = useUIStore((state) => state.settingsTab)

  const activeTab = settingsTab === 'extension' ? 'custom' : 'builtin'
  const [overviewExpanded, setOverviewExpanded] = React.useState(false)
  const tabRefs = React.useRef<Array<HTMLButtonElement | null>>([])
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
    <div className="capability-center flex h-full min-h-0 flex-col gap-5">
      <section aria-labelledby="capability-center-title" className="shrink-0">
        <SettingsPageHeader
          titleId="capability-center-title"
          title={t(activeTab === 'custom' ? 'plugin.customPlugins' : 'plugin.title')}
          description={t(
            activeTab === 'custom' ? 'extension.subtitle' : 'capabilityCenter.description'
          )}
        />
      </section>

      {activeTab === 'builtin' ? (
        <>
          <Button
            id="capability-center-overview-toggle"
            type="button"
            variant="outline"
            className="capability-center-overview-toggle h-auto w-full justify-between whitespace-normal text-left"
            aria-controls="capability-center-overview"
            aria-expanded={overviewExpanded}
            onClick={() => setOverviewExpanded((expanded) => !expanded)}
          >
            <span>
              {t('capabilityCenter.healthTitle')} · {t('capabilityCenter.lifecycleTitle')}
            </span>
            {overviewExpanded ? (
              <ChevronUp className="size-4 shrink-0" aria-hidden="true" />
            ) : (
              <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
            )}
          </Button>
          <div
            id="capability-center-overview"
            className={`capability-center-overview space-y-5 ${overviewExpanded ? 'is-expanded' : ''}`}
          >
            <CapabilityHealthSummary />

            <section className="shrink-0 rounded-lg border border-border/60 bg-muted/10 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-medium">{t('capabilityCenter.lifecycleTitle')}</h2>
                  <p className="text-[0.8125rem] text-muted-foreground">
                    {t('capabilityCenter.lifecycleDescription')}
                  </p>
                </div>
                <Badge variant="outline" className="shrink-0 text-xs">
                  {t('capabilityCenter.lifecyclePolicy')}
                </Badge>
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {CAPABILITY_LIFECYCLE.map((capability) => (
                  <div
                    key={capability.id}
                    className="flex items-center gap-2 rounded-md border border-border/50 px-2 py-1.5"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {t(`capabilityCenter.capabilities.${capability.id}`)}
                    </span>
                    <Badge
                      variant={capability.status === 'ga' ? 'default' : 'secondary'}
                      className="h-5 px-1.5 text-xs"
                    >
                      {t(`capabilityCenter.status.${capability.status}`)}
                    </Badge>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </>
      ) : null}

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
            id={`capability-tab-${tab.id}`}
            aria-controls={`capability-panel-${tab.id}`}
            aria-selected={activeTab === tab.id}
            tabIndex={activeTab === tab.id ? 0 : -1}
            ref={(element) => {
              tabRefs.current[tabs.indexOf(tab)] = element
            }}
            onKeyDown={(event) => {
              const currentIndex = tabs.findIndex((item) => item.id === activeTab)
              let nextIndex = currentIndex
              if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length
              else if (event.key === 'ArrowLeft')
                nextIndex = (currentIndex + tabs.length - 1) % tabs.length
              else if (event.key === 'Home') nextIndex = 0
              else if (event.key === 'End') nextIndex = tabs.length - 1
              else return
              event.preventDefault()
              const nextTab = tabs[nextIndex]
              setSettingsTab(nextTab.id === 'custom' ? 'extension' : 'plugin')
              tabRefs.current[nextIndex]?.focus()
            }}
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

      <div
        id={`capability-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`capability-tab-${activeTab}`}
        tabIndex={0}
        className="capability-center-tabpanel min-h-0 min-w-0 flex-1 outline-none"
      >
        {activeTab === 'custom' ? <ExtensionPanel embedded /> : <AppPluginPanel embedded />}
      </div>
    </div>
  )
}
