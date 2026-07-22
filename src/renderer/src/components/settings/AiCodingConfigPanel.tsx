import * as React from 'react'
import { Copy, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { useProviderStore } from '@renderer/stores/provider-store'
import type { AIProvider } from '@renderer/lib/api/types'
import {
  AI_CODING_PERMISSION_MODES,
  AI_CODING_TOOLS,
  type AiCodingConfig,
  type AiCodingPermissionMode,
  type AiCodingTool
} from '../../../../shared/ai-coding-config'

function compatible(provider: AIProvider, tool: AiCodingTool): boolean {
  return tool === 'claude-code'
    ? provider.type === 'anthropic'
    : provider.type === 'openai-chat' || provider.type === 'openai-responses'
}

function providerAuthReady(provider?: AIProvider): boolean {
  if (!provider) return false
  if (provider.requiresApiKey === false) return true
  if (provider.authMode === 'oauth') {
    return Boolean(provider.oauth?.accessToken || provider.oauthAccounts?.length)
  }
  return Boolean(provider.apiKey.trim())
}

function draftConfig(provider?: AIProvider): AiCodingConfig {
  const now = Date.now()
  return {
    id: '',
    name: 'AI Coding',
    tool: 'codex',
    providerId: provider?.id ?? '',
    modelId: provider?.models.find((model) => model.enabled)?.id ?? '',
    permissionMode: 'standard',
    enabled: true,
    createdAt: now,
    updatedAt: now
  }
}

export function AiCodingConfigPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const providers = useProviderStore((state) => state.providers)
  const [configs, setConfigs] = React.useState<AiCodingConfig[]>([])
  const [selectedId, setSelectedId] = React.useState('')
  const [draft, setDraft] = React.useState<AiCodingConfig>(() => draftConfig(providers[0]))
  const [saving, setSaving] = React.useState(false)

  const load = React.useCallback(async () => {
    const result = (await ipcClient.invoke(IPC.AI_CODING_CONFIGS_LIST)) as {
      success: boolean
      configs?: AiCodingConfig[]
    }
    const next = result.success && Array.isArray(result.configs) ? result.configs : []
    setConfigs(next)
    if (next.length > 0) {
      setSelectedId((current) => current || next[0].id)
      setDraft(next.find((config) => config.id === selectedId) ?? next[0])
    }
  }, [selectedId])

  React.useEffect(() => {
    void load()
    // Loading is intentionally limited to panel mount; saves update local state directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedProvider = providers.find((provider) => provider.id === draft.providerId)
  const compatibleProviders = providers.filter(
    (provider) => provider.enabled && compatible(provider, draft.tool)
  )
  const models = selectedProvider?.models.filter(
    (model) => model.enabled && (model.category ?? 'chat') === 'chat'
  )
  const selectedModel = models?.find((model) => model.id === draft.modelId)
  const validation = !selectedProvider
    ? 'providerMissing'
    : !selectedProvider.enabled
      ? 'providerDisabled'
      : !compatible(selectedProvider, draft.tool)
        ? 'protocolMismatch'
        : !selectedProvider.baseUrl.trim()
          ? 'baseUrlMissing'
          : !providerAuthReady(selectedProvider)
            ? 'authMissing'
            : !selectedModel
              ? 'modelMissing'
              : null

  const selectConfig = (config: AiCodingConfig): void => {
    setSelectedId(config.id)
    setDraft(config)
  }

  const save = async (): Promise<void> => {
    if (validation || !draft.name.trim()) return
    setSaving(true)
    try {
      const result = (await ipcClient.invoke(IPC.AI_CODING_CONFIGS_SAVE, draft)) as {
        success: boolean
        config?: AiCodingConfig
      }
      if (!result.success || !result.config) throw new Error('save_failed')
      setConfigs((current) => [
        ...current.filter((config) => config.id !== result.config?.id),
        result.config as AiCodingConfig
      ])
      setSelectedId(result.config.id)
      setDraft(result.config)
      toast.success(t('aiCoding.saved'))
    } catch {
      toast.error(t('aiCoding.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!draft.id) return
    await ipcClient.invoke(IPC.AI_CODING_CONFIGS_DELETE, { id: draft.id })
    const next = configs.filter((config) => config.id !== draft.id)
    setConfigs(next)
    setSelectedId(next[0]?.id ?? '')
    setDraft(next[0] ?? draftConfig(providers[0]))
  }

  const newConfig = (): void => {
    const provider = providers.find(
      (candidate) => candidate.enabled && compatible(candidate, 'codex')
    )
    setSelectedId('')
    setDraft(draftConfig(provider))
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="rounded-xl border bg-muted/10 p-3">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">{t('aiCoding.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('aiCoding.subtitle')}</p>
          </div>
          <Button size="icon" variant="ghost" onClick={newConfig}>
            <Plus className="size-4" />
          </Button>
        </div>
        <div className="space-y-1">
          {configs.map((config) => (
            <button
              key={config.id}
              type="button"
              className={`w-full rounded-lg px-3 py-2 text-left text-xs ${selectedId === config.id ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}
              onClick={() => selectConfig(config)}
            >
              <span className="block truncate font-medium">{config.name}</span>
              <span className="mt-0.5 block truncate text-[10px] opacity-70">
                {config.tool} · {config.modelId}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="space-y-4 rounded-xl border p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-xs">
            <span className="font-medium">{t('aiCoding.name')}</span>
            <Input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-medium">{t('aiCoding.tool')}</span>
            <Select
              value={draft.tool}
              onValueChange={(tool: AiCodingTool) => {
                const provider = providers.find(
                  (candidate) => candidate.enabled && compatible(candidate, tool)
                )
                setDraft({
                  ...draft,
                  tool,
                  providerId: provider?.id ?? '',
                  modelId: provider?.models.find((model) => model.enabled)?.id ?? ''
                })
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AI_CODING_TOOLS.map((tool) => (
                  <SelectItem key={tool} value={tool}>
                    {tool}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-medium">{t('aiCoding.provider')}</span>
            <Select
              value={draft.providerId}
              onValueChange={(providerId) => {
                const provider = providers.find((candidate) => candidate.id === providerId)
                setDraft({
                  ...draft,
                  providerId,
                  modelId: provider?.models.find((model) => model.enabled)?.id ?? ''
                })
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {compatibleProviders.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-medium">{t('aiCoding.model')}</span>
            <Select
              value={draft.modelId}
              onValueChange={(modelId) => setDraft({ ...draft, modelId })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(models ?? []).map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-medium">{t('aiCoding.permissionMode')}</span>
            <Select
              value={draft.permissionMode}
              onValueChange={(permissionMode: AiCodingPermissionMode) =>
                setDraft({ ...draft, permissionMode })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AI_CODING_PERMISSION_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(`aiCoding.permissions.${mode}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <div className="flex items-end justify-between rounded-lg border px-3 py-2">
            <span className="text-xs font-medium">{t('aiCoding.enabled')}</span>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
            />
          </div>
        </div>

        <div className="rounded-lg border bg-muted/15 p-3 text-xs">
          <p className="font-medium">{t('aiCoding.mapping')}</p>
          <p className="mt-1 text-muted-foreground">
            {selectedProvider?.name ?? '—'} / {selectedModel?.name ?? '—'} ·{' '}
            {selectedProvider?.baseUrl || '—'}
          </p>
          <p className="mt-1 text-muted-foreground">
            {t('aiCoding.credential')}:{' '}
            {providerAuthReady(selectedProvider) ? '••••••••' : t('aiCoding.notConfigured')}
          </p>
          {validation ? (
            <p className="mt-2 text-destructive">{t(`aiCoding.validation.${validation}`)}</p>
          ) : null}
        </div>

        <div className="flex justify-between gap-2">
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!draft.id}
              onClick={() => setDraft({ ...draft, id: '', name: `${draft.name} Copy` })}
            >
              <Copy className="mr-2 size-3.5" />
              {t('aiCoding.copy')}
            </Button>
            <Button variant="destructive" disabled={!draft.id} onClick={() => void remove()}>
              <Trash2 className="mr-2 size-3.5" />
              {t('aiCoding.delete')}
            </Button>
          </div>
          <Button
            disabled={saving || Boolean(validation) || !draft.name.trim()}
            onClick={() => void save()}
          >
            {saving ? t('aiCoding.saving') : t('aiCoding.save')}
          </Button>
        </div>
      </section>
    </div>
  )
}
