import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import {
  clampMaxConcurrentSubAgents,
  clampMaxParallelToolCalls,
  clampProviderRetryMaxAttempts,
  useSettingsStore
} from '@renderer/stores/settings-store'
import {
  clampCompressionThreshold,
  MAX_CONTEXT_COMPRESSION_THRESHOLD,
  MIN_CONTEXT_COMPRESSION_THRESHOLD
} from '@renderer/lib/agent/context-compression'
import {
  isProviderAvailableForModelSelection,
  useProviderStore
} from '@renderer/stores/provider-store'
import { SETTINGS_PANEL_CLASS, SettingsPageHeader } from './settings-primitives'

export function AdvancedSettingsPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useSettingsStore()
  const providers = useProviderStore((state) => state.providers)
  const compressionModels = useMemo(
    () =>
      providers.flatMap((provider) =>
        provider.models
          .filter(
            (model) =>
              model.enabled &&
              (model.category ?? 'chat') === 'chat' &&
              isProviderAvailableForModelSelection(provider)
          )
          .map((model) => ({
            value: `${provider.id}::${model.id}`,
            label: `${provider.name} · ${model.name ?? model.id}`
          }))
      ),
    [providers]
  )
  const compressionValue = settings.contextCompressionModel
    ? `${settings.contextCompressionModel.providerId}::${settings.contextCompressionModel.modelId}`
    : 'current'

  return (
    <div className={SETTINGS_PANEL_CLASS}>
      <SettingsPageHeader
        title={t('architecture.pages.advanced.title')}
        description={t('architecture.pages.advanced.description')}
      />

      <section className="space-y-4 rounded-xl border border-border/60 bg-muted/15 p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">{t('general.contextCompression')}</p>
            <p className="text-xs text-muted-foreground">{t('general.contextCompressionDesc')}</p>
          </div>
          <Switch
            checked={settings.contextCompressionEnabled}
            onCheckedChange={(checked) =>
              settings.updateSettings({ contextCompressionEnabled: checked })
            }
          />
        </div>
        {settings.contextCompressionEnabled && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span className="font-medium">{t('general.contextCompressionThreshold')}</span>
              <Input
                type="number"
                min={MIN_CONTEXT_COMPRESSION_THRESHOLD * 100}
                max={MAX_CONTEXT_COMPRESSION_THRESHOLD * 100}
                value={Math.round(settings.contextCompressionThreshold * 100)}
                onChange={(event) =>
                  settings.updateSettings({
                    contextCompressionThreshold: clampCompressionThreshold(
                      Number(event.target.value) / 100
                    )
                  })
                }
              />
              <span className="text-muted-foreground">
                {t('general.contextCompressionThresholdDesc')}
              </span>
            </label>
            <label className="space-y-1 text-xs">
              <span className="font-medium">{t('general.contextCompressionModel')}</span>
              <Select
                value={compressionValue}
                onValueChange={(value) => {
                  const [providerId, modelId] = value === 'current' ? [] : value.split('::')
                  settings.updateSettings({
                    contextCompressionModel: providerId && modelId ? { providerId, modelId } : null
                  })
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="current">
                    {t('general.contextCompressionModelCurrent')}
                  </SelectItem>
                  {compressionModels.map((model) => (
                    <SelectItem key={model.value} value={model.value}>
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
        )}
      </section>

      <section className="grid gap-4 rounded-xl border border-border/60 bg-muted/15 p-4 sm:grid-cols-2">
        <NumericSetting
          label={t('general.maxParallelToolCalls')}
          description={t('general.maxParallelToolCallsDesc')}
          value={settings.maxParallelToolCalls}
          onChange={(value) =>
            settings.updateSettings({ maxParallelToolCalls: clampMaxParallelToolCalls(value) })
          }
        />
        <NumericSetting
          label={t('general.maxConcurrentSubAgents')}
          description={t('general.maxConcurrentSubAgentsDesc')}
          value={settings.maxConcurrentSubAgents}
          onChange={(value) =>
            settings.updateSettings({ maxConcurrentSubAgents: clampMaxConcurrentSubAgents(value) })
          }
        />
        <NumericSetting
          label={t('general.providerRetryMaxAttempts')}
          description={t('general.providerRetryMaxAttemptsDesc')}
          value={settings.providerRetryMaxAttempts}
          onChange={(value) =>
            settings.updateSettings({
              providerRetryMaxAttempts: clampProviderRetryMaxAttempts(value)
            })
          }
        />
        <label className="space-y-1 text-xs">
          <span className="font-medium">{t('general.toolResultFormat')}</span>
          <span className="block text-muted-foreground">{t('general.toolResultFormatDesc')}</span>
          <Select
            value={settings.toolResultFormat}
            onValueChange={(toolResultFormat: 'toon' | 'json') =>
              settings.updateSettings({ toolResultFormat })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="toon">{t('general.toolResultFormatToon')}</SelectItem>
              <SelectItem value="json">{t('general.toolResultFormatJson')}</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </section>

      <section className="space-y-1 rounded-xl border border-border/60 bg-muted/15 p-4">
        <ToggleSetting
          title={t('general.teamTools')}
          description={t('general.teamToolsDesc')}
          checked={settings.teamToolsEnabled}
          onChange={(teamToolsEnabled) => settings.updateSettings({ teamToolsEnabled })}
        />
        <ToggleSetting
          title={t('general.editorWorkspace')}
          description={t('general.editorWorkspaceDesc')}
          checked={settings.editorWorkspaceEnabled}
          onChange={(editorWorkspaceEnabled) =>
            settings.updateSettings({
              editorWorkspaceEnabled,
              editorRemoteLanguageServiceEnabled: editorWorkspaceEnabled
                ? settings.editorRemoteLanguageServiceEnabled
                : false
            })
          }
        />
        <ToggleSetting
          title={t('general.editorRemoteLanguageService')}
          description={t('general.editorRemoteLanguageServiceDesc')}
          checked={settings.editorRemoteLanguageServiceEnabled}
          disabled={!settings.editorWorkspaceEnabled}
          onChange={(editorRemoteLanguageServiceEnabled) =>
            settings.updateSettings({ editorRemoteLanguageServiceEnabled })
          }
        />
        <ToggleSetting
          title={t('general.clarifyAutoAcceptRecommended')}
          description={t('general.clarifyAutoAcceptRecommendedDesc')}
          checked={settings.clarifyAutoAcceptRecommended}
          onChange={(clarifyAutoAcceptRecommended) =>
            settings.updateSettings({ clarifyAutoAcceptRecommended })
          }
        />
        <ToggleSetting
          title={t('general.autoApprove')}
          description={t('general.autoApproveDesc')}
          checked={settings.autoApprove}
          onChange={async (autoApprove) => {
            if (autoApprove && !(await confirm({ title: t('general.autoApproveWarning') }))) return
            settings.updateSettings({ autoApprove })
          }}
        />
        <ToggleSetting
          title={t('general.advancedDraw')}
          description={t('general.advancedDrawDesc')}
          checked={settings.advancedDrawEnabled}
          onChange={(advancedDrawEnabled) => settings.updateSettings({ advancedDrawEnabled })}
        />
        <ToggleSetting
          title={t('general.videoGeneration')}
          description={t('general.videoGenerationDesc')}
          checked={settings.videoGenerationEnabled}
          onChange={(videoGenerationEnabled) => settings.updateSettings({ videoGenerationEnabled })}
        />
        <ToggleSetting
          title={t('general.devMode')}
          description={t('general.devModeDesc')}
          checked={settings.devMode}
          onChange={(devMode) => settings.updateSettings({ devMode })}
        />
      </section>
    </div>
  )
}

function NumericSetting({
  label,
  description,
  value,
  onChange
}: {
  label: string
  description: string
  value: number
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <label className="space-y-1 text-xs">
      <span className="font-medium">{label}</span>
      <span className="block text-muted-foreground">{description}</span>
      <Input
        type="number"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}

function ToggleSetting({
  title,
  description,
  checked,
  disabled = false,
  onChange
}: {
  title: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void | Promise<void>
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/50 py-3 last:border-0">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  )
}
