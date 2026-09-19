import * as React from 'react'
import { BriefcaseBusiness, Code2, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Switch } from '@renderer/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useProviderStore } from '@renderer/stores/provider-store'
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_PANEL_CLASS,
  SettingsPageHeader
} from './settings-primitives'
import {
  DEFAULT_CODE_PROFILE,
  DEFAULT_WORK_PROFILE,
  type TaskProfile
} from '@renderer/lib/task-profile'

type ProfileTab = TaskProfile | 'shared'

function SettingToggle({
  label,
  description,
  checked,
  onCheckedChange,
  disabled
}: {
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/50 py-4 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  )
}

export function WorkModesPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useSettingsStore()
  const providers = useProviderStore((state) => state.providers)
  const [activeTab, setActiveTab] = React.useState<ProfileTab>('work')

  const updateProfile = React.useCallback(
    (profile: TaskProfile, patch: Record<string, unknown>) => {
      const key = profile === 'work' ? 'workProfileConfig' : 'codeProfileConfig'
      const current = profile === 'work' ? settings.workProfileConfig : settings.codeProfileConfig
      settings.updateSettings({ [key]: { ...current, ...patch } })
    },
    [settings]
  )

  const profile = activeTab === 'code' ? settings.codeProfileConfig : settings.workProfileConfig
  const profileDefaults = activeTab === 'code' ? DEFAULT_CODE_PROFILE : DEFAULT_WORK_PROFILE
  const modelOptions = React.useMemo(
    () =>
      providers.flatMap((provider) =>
        provider.models
          .filter((model) => model.enabled !== false)
          .map((model) => ({
            value: `${provider.id}::${model.id}`,
            label: `${provider.name} · ${model.name ?? model.id}`
          }))
      ),
    [providers]
  )

  const profileModelValue = (providerId?: string | null, modelId?: string | null): string =>
    providerId && modelId ? `${providerId}::${modelId}` : 'inherit'

  const updateProfileModel = (
    profileName: TaskProfile,
    fieldPrefix: 'main' | 'fast',
    value: string
  ): void => {
    const [providerId, modelId] = value === 'inherit' ? [null, null] : value.split('::')
    updateProfile(profileName, {
      [`${fieldPrefix}ProviderId`]: providerId,
      [`${fieldPrefix}ModelId`]: modelId
    })
  }

  return (
    <section className={SETTINGS_PANEL_CLASS}>
      <SettingsPageHeader title={t('workModes.title')} description={t('workModes.subtitle')} />

      <div className="flex gap-1 border-b border-border/60" role="tablist">
        {(
          [
            ['work', BriefcaseBusiness, 'workModes.work'],
            ['code', Code2, 'workModes.code'],
            ['shared', ShieldCheck, 'workModes.sharedLabel']
          ] as const
        ).map(([value, Icon, key]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={activeTab === value}
            onClick={() => setActiveTab(value)}
            className={`flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors ${
              activeTab === value
                ? 'border-foreground font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="size-4" />
            {t(key)}
          </button>
        ))}
      </div>

      {activeTab === 'shared' ? (
        <div className="space-y-4">
          <div className={SETTINGS_CARD_CLASS}>
            <p className="text-sm font-medium">{t('workModes.shared.securityTitle')}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t('workModes.shared.securityDesc')}
            </p>
          </div>
          <div className={SETTINGS_CARD_CLASS}>
            <p className="text-sm font-medium">{t('workModes.shared.defaultTitle')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('workModes.shared.defaultDesc')}
            </p>
            <div className="mt-3 flex gap-2">
              {(['work', 'code'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={settings.defaultTaskProfile === value}
                  onClick={() => settings.updateSettings({ defaultTaskProfile: value })}
                  className={`rounded-md border px-3 py-2 text-xs ${
                    settings.defaultTaskProfile === value
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border/60 text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {value === 'work' ? t('workModes.work') : t('workModes.code')}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className={SETTINGS_CARD_CLASS}>
          <div className="grid gap-4 border-b border-border/50 py-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor={`${activeTab}-main-model`}>
                {t('workModes.mainModel')}
              </label>
              <Select
                value={profileModelValue(profile.mainProviderId, profile.mainModelId)}
                onValueChange={(value) => updateProfileModel(activeTab, 'main', value)}
              >
                <SelectTrigger id={`${activeTab}-main-model`}>
                  <SelectValue placeholder={t('workModes.inheritModel')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">{t('workModes.inheritModel')}</SelectItem>
                  {modelOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor={`${activeTab}-fast-model`}>
                {t('workModes.fastModel')}
              </label>
              <Select
                value={profileModelValue(profile.fastProviderId, profile.fastModelId)}
                onValueChange={(value) => updateProfileModel(activeTab, 'fast', value)}
              >
                <SelectTrigger id={`${activeTab}-fast-model`}>
                  <SelectValue placeholder={t('workModes.inheritFastModel')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">{t('workModes.inheritFastModel')}</SelectItem>
                  {modelOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <SettingToggle
            label={t('workModes.autoSummarize')}
            description={t('workModes.autoSummarizeDesc')}
            checked={profile.autoSummarize}
            onCheckedChange={(checked) => updateProfile(activeTab, { autoSummarize: checked })}
          />
          <SettingToggle
            label={t('workModes.preferBrowser')}
            description={t('workModes.preferBrowserDesc')}
            checked={profile.preferBrowser}
            onCheckedChange={(checked) => updateProfile(activeTab, { preferBrowser: checked })}
            disabled={activeTab === 'code'}
          />
          <SettingToggle
            label={t('workModes.preferWebSearch')}
            description={t('workModes.preferWebSearchDesc')}
            checked={profile.preferWebSearch}
            onCheckedChange={(checked) => updateProfile(activeTab, { preferWebSearch: checked })}
            disabled={activeTab === 'code'}
          />
          <SettingToggle
            label={t('workModes.autoIndex')}
            description={t('workModes.autoIndexDesc')}
            checked={profile.autoIndex}
            onCheckedChange={(checked) => updateProfile(activeTab, { autoIndex: checked })}
            disabled={activeTab === 'work'}
          />
          <SettingToggle
            label={t('workModes.allowShell')}
            description={t('workModes.allowShellDesc')}
            checked={profile.allowShell}
            onCheckedChange={(checked) => updateProfile(activeTab, { allowShell: checked })}
            disabled={activeTab === 'work'}
          />
          {activeTab === 'code' && (
            <div className="grid gap-4 border-t border-border/50 py-4 sm:grid-cols-2">
              <ProfileSelect
                id="code-shell-type"
                label={t('workModes.shellType')}
                value={profile.shellType ?? 'default'}
                onValueChange={(value) => updateProfile(activeTab, { shellType: value })}
                options={[
                  ['default', t('workModes.shellDefault')],
                  ['powershell', 'PowerShell'],
                  ['bash', 'Bash']
                ]}
              />
              <ProfileSelect
                id="code-git-policy"
                label={t('workModes.gitPolicy')}
                value={profile.gitPolicy ?? 'ask-before-write'}
                onValueChange={(value) => updateProfile(activeTab, { gitPolicy: value })}
                options={[
                  ['inspect-only', t('workModes.gitInspect')],
                  ['ask-before-write', t('workModes.gitAsk')],
                  ['allow-with-approval', t('workModes.gitApproval')]
                ]}
              />
              <ProfileSelect
                id="code-verification-policy"
                label={t('workModes.verificationPolicy')}
                value={profile.verificationPolicy ?? 'tests-and-build'}
                onValueChange={(value) => updateProfile(activeTab, { verificationPolicy: value })}
                options={[
                  ['none', t('workModes.verifyNone')],
                  ['lint-and-typecheck', t('workModes.verifyStatic')],
                  ['tests-and-build', t('workModes.verifyFull')]
                ]}
              />
              <ProfileSelect
                id="code-diff-style"
                label={t('workModes.diffStyle')}
                value={profile.diffStyle ?? 'side-panel'}
                onValueChange={(value) => updateProfile(activeTab, { diffStyle: value })}
                options={[
                  ['inline', t('workModes.diffInline')],
                  ['side-panel', t('workModes.diffSidePanel')]
                ]}
              />
              <ProfileSelect
                id="code-file-approval"
                label={t('workModes.fileApproval')}
                value={profile.fileApprovalPolicy ?? 'ask-on-risk'}
                onValueChange={(value) => updateProfile(activeTab, { fileApprovalPolicy: value })}
                options={[
                  ['always-ask', t('workModes.approvalAlways')],
                  ['ask-on-risk', t('workModes.approvalRisk')],
                  ['use-global', t('workModes.approvalGlobal')]
                ]}
              />
              <SettingToggle
                label={t('workModes.useTeams')}
                description={t('workModes.useTeamsDesc')}
                checked={profile.useTeams ?? false}
                onCheckedChange={(checked) => updateProfile(activeTab, { useTeams: checked })}
              />
            </div>
          )}
          <div className="border-t border-border/50 py-4 text-xs text-muted-foreground">
            {t('workModes.defaultsDescription', {
              mode: t(
                profileDefaults.defaultSessionMode === 'chat'
                  ? 'workModes.defaultsChat'
                  : 'workModes.defaultsExecution'
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}

function ProfileSelect({
  id,
  label,
  value,
  onValueChange,
  options
}: {
  id: string
  label: string
  value: string
  onValueChange: (value: string) => void
  options: Array<[string, string]>
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([optionValue, optionLabel]) => (
            <SelectItem key={optionValue} value={optionValue}>
              {optionLabel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
