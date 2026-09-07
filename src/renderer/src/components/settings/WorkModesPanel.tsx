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
    <section className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">
          {t('workModes.title', { defaultValue: 'Work modes' })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('workModes.subtitle', {
            defaultValue: 'Choose how Ola prioritizes everyday work and software projects.'
          })}
        </p>
      </div>

      <div className="flex gap-1 border-b border-border/60" role="tablist">
        {([
          ['work', BriefcaseBusiness, 'workModes.work'],
          ['code', Code2, 'workModes.code'],
          ['shared', ShieldCheck, 'workModes.sharedLabel']
        ] as const).map(([value, Icon, key]) => (
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
            {t(key, {
              defaultValue: value === 'work' ? 'Work' : value === 'code' ? 'Code' : 'Shared'
            })}
          </button>
        ))}
      </div>

      {activeTab === 'shared' ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-border/60 bg-background/50 p-4">
            <p className="text-sm font-medium">
              {t('workModes.shared.securityTitle', { defaultValue: 'Security stays global' })}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t('workModes.shared.securityDesc', {
                defaultValue:
                  'Permissions, approvals, credentials, MCP, Extensions and desktop automation are shared by both profiles.'
              })}
            </p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/50 p-4">
            <p className="text-sm font-medium">
              {t('workModes.shared.defaultTitle', { defaultValue: 'Default profile' })}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('workModes.shared.defaultDesc', {
                defaultValue: 'New conversations start with this profile. You can override it before sending.'
              })}
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
                  {value === 'work'
                    ? t('workModes.work', { defaultValue: 'Work' })
                    : t('workModes.code', { defaultValue: 'Code' })}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-border/60 bg-background/50 px-4">
          <div className="grid gap-4 border-b border-border/50 py-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor={`${activeTab}-main-model`}>
                {t('workModes.mainModel', { defaultValue: 'Main model' })}
              </label>
              <Select
                value={profileModelValue(profile.mainProviderId, profile.mainModelId)}
                onValueChange={(value) => updateProfileModel(activeTab, 'main', value)}
              >
                <SelectTrigger id={`${activeTab}-main-model`}>
                  <SelectValue placeholder={t('workModes.inheritModel', { defaultValue: 'Inherit global model' })} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">
                    {t('workModes.inheritModel', { defaultValue: 'Inherit global model' })}
                  </SelectItem>
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
                {t('workModes.fastModel', { defaultValue: 'Fast model' })}
              </label>
              <Select
                value={profileModelValue(profile.fastProviderId, profile.fastModelId)}
                onValueChange={(value) => updateProfileModel(activeTab, 'fast', value)}
              >
                <SelectTrigger id={`${activeTab}-fast-model`}>
                  <SelectValue placeholder={t('workModes.inheritFastModel', { defaultValue: 'Inherit global fast model' })} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">
                    {t('workModes.inheritFastModel', { defaultValue: 'Inherit global fast model' })}
                  </SelectItem>
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
            label={t('workModes.autoSummarize', { defaultValue: 'Generate a structured result' })}
            description={t('workModes.autoSummarizeDesc', {
              defaultValue: 'After tool work, summarize what changed, what was verified and what remains.'
            })}
            checked={profile.autoSummarize}
            onCheckedChange={(checked) => updateProfile(activeTab, { autoSummarize: checked })}
          />
          <SettingToggle
            label={t('workModes.preferBrowser', { defaultValue: 'Prioritize browser actions' })}
            description={t('workModes.preferBrowserDesc', {
              defaultValue: 'Place browser and desktop research capabilities near the top of the tool picker.'
            })}
            checked={profile.preferBrowser}
            onCheckedChange={(checked) => updateProfile(activeTab, { preferBrowser: checked })}
            disabled={activeTab === 'code'}
          />
          <SettingToggle
            label={t('workModes.preferWebSearch', { defaultValue: 'Prioritize web research' })}
            description={t('workModes.preferWebSearchDesc', {
              defaultValue: 'Prefer search and source gathering for research-oriented tasks.'
            })}
            checked={profile.preferWebSearch}
            onCheckedChange={(checked) => updateProfile(activeTab, { preferWebSearch: checked })}
            disabled={activeTab === 'code'}
          />
          <SettingToggle
            label={t('workModes.autoIndex', { defaultValue: 'Keep project intelligence ready' })}
            description={t('workModes.autoIndexDesc', {
              defaultValue: 'Prefer CodeGraph and Wiki indexing when a project is selected.'
            })}
            checked={profile.autoIndex}
            onCheckedChange={(checked) => updateProfile(activeTab, { autoIndex: checked })}
            disabled={activeTab === 'work'}
          />
          <SettingToggle
            label={t('workModes.allowShell', { defaultValue: 'Show shell capabilities' })}
            description={t('workModes.allowShellDesc', {
              defaultValue: 'Expose terminal and command tools as preferred Code capabilities; approvals still apply.'
            })}
            checked={profile.allowShell}
            onCheckedChange={(checked) => updateProfile(activeTab, { allowShell: checked })}
            disabled={activeTab === 'work'}
          />
          {activeTab === 'code' && (
            <div className="grid gap-4 border-t border-border/50 py-4 sm:grid-cols-2">
              <ProfileSelect
                id="code-shell-type"
                label={t('workModes.shellType', { defaultValue: 'Shell type' })}
                value={profile.shellType ?? 'default'}
                onValueChange={(value) => updateProfile(activeTab, { shellType: value })}
                options={[
                  ['default', t('workModes.shellDefault', { defaultValue: 'System default' })],
                  ['powershell', 'PowerShell'],
                  ['bash', 'Bash']
                ]}
              />
              <ProfileSelect
                id="code-git-policy"
                label={t('workModes.gitPolicy', { defaultValue: 'Git policy' })}
                value={profile.gitPolicy ?? 'ask-before-write'}
                onValueChange={(value) => updateProfile(activeTab, { gitPolicy: value })}
                options={[
                  ['inspect-only', t('workModes.gitInspect', { defaultValue: 'Inspect only' })],
                  ['ask-before-write', t('workModes.gitAsk', { defaultValue: 'Ask before write' })],
                  ['allow-with-approval', t('workModes.gitApproval', { defaultValue: 'Allow with approval' })]
                ]}
              />
              <ProfileSelect
                id="code-verification-policy"
                label={t('workModes.verificationPolicy', { defaultValue: 'Verification policy' })}
                value={profile.verificationPolicy ?? 'tests-and-build'}
                onValueChange={(value) => updateProfile(activeTab, { verificationPolicy: value })}
                options={[
                  ['none', t('workModes.verifyNone', { defaultValue: 'No automatic verification' })],
                  ['lint-and-typecheck', t('workModes.verifyStatic', { defaultValue: 'Lint and typecheck' })],
                  ['tests-and-build', t('workModes.verifyFull', { defaultValue: 'Tests and build' })]
                ]}
              />
              <ProfileSelect
                id="code-diff-style"
                label={t('workModes.diffStyle', { defaultValue: 'Diff display' })}
                value={profile.diffStyle ?? 'side-panel'}
                onValueChange={(value) => updateProfile(activeTab, { diffStyle: value })}
                options={[
                  ['inline', t('workModes.diffInline', { defaultValue: 'Inline in conversation' })],
                  ['side-panel', t('workModes.diffSidePanel', { defaultValue: 'Open in side panel' })]
                ]}
              />
              <ProfileSelect
                id="code-file-approval"
                label={t('workModes.fileApproval', { defaultValue: 'File approval' })}
                value={profile.fileApprovalPolicy ?? 'ask-on-risk'}
                onValueChange={(value) => updateProfile(activeTab, { fileApprovalPolicy: value })}
                options={[
                  ['always-ask', t('workModes.approvalAlways', { defaultValue: 'Always ask' })],
                  ['ask-on-risk', t('workModes.approvalRisk', { defaultValue: 'Ask on risk' })],
                  ['use-global', t('workModes.approvalGlobal', { defaultValue: 'Use global policy' })]
                ]}
              />
              <SettingToggle
                label={t('workModes.useTeams', { defaultValue: 'Prefer Team delegation' })}
                description={t('workModes.useTeamsDesc', {
                  defaultValue: 'Suggest sub-agents and Team workflows for larger engineering tasks.'
                })}
                checked={profile.useTeams ?? false}
                onCheckedChange={(checked) => updateProfile(activeTab, { useTeams: checked })}
              />
            </div>
          )}
          <div className="border-t border-border/50 py-4 text-xs text-muted-foreground">
            {t('workModes.defaultsHint', {
              defaultValue: `Defaults: ${profileDefaults.defaultSessionMode === 'chat' ? 'starts with conversation' : 'starts with execution'}. Profile changes apply to new conversations.`
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
