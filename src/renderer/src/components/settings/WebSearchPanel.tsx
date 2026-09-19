import { useState, useCallback, useEffect, useRef } from 'react'
import { Search, Key, Clock, Hash } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Separator } from '@renderer/components/ui/separator'
import { Switch } from '@renderer/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { toast } from 'sonner'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import type { WebSearchProvider } from '@renderer/lib/tools/web-search-tool'
import { SETTINGS_PANEL_CLASS, SettingsPageHeader } from './settings-primitives'

export function WebSearchPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useSettingsStore()
  const [testing, setTesting] = useState(false)
  const [savingKey, setSavingKey] = useState(false)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [secretStatus, setSecretStatus] = useState<{ configured: boolean; suffix: string | null }>({
    configured: false,
    suffix: null
  })
  const importedLegacyKey = useRef(false)

  const refreshSecretStatus = useCallback(async () => {
    const status = (await ipcClient.invoke(IPC.WEB_SEARCH_SECRET_STATUS)) as {
      configured: boolean
      suffix: string | null
    }
    setSecretStatus(status)
    return status
  }, [])

  useEffect(() => {
    void (async () => {
      const status = await refreshSecretStatus()
      // Compatibility import for existing installations. This is intentionally
      // the only path that reads the deprecated persisted value.
      if (!status.configured && settings.webSearchApiKey && !importedLegacyKey.current) {
        importedLegacyKey.current = true
        const imported = (await ipcClient.invoke(IPC.WEB_SEARCH_SECRET_SET, {
          apiKey: settings.webSearchApiKey
        })) as { configured: boolean; suffix: string | null }
        setSecretStatus(imported)
        settings.updateSettings({ webSearchApiKey: '' })
      }
    })().catch(() => undefined)
  }, [refreshSecretStatus, settings, settings.webSearchApiKey])

  const saveApiKey = useCallback(async () => {
    if (!apiKeyDraft.trim()) return
    setSavingKey(true)
    try {
      const status = (await ipcClient.invoke(IPC.WEB_SEARCH_SECRET_SET, {
        apiKey: apiKeyDraft
      })) as { configured: boolean; suffix: string | null }
      setSecretStatus(status)
      setApiKeyDraft('')
      settings.updateSettings({ webSearchApiKey: '' })
      window.dispatchEvent(new Event('ola:web-search-secret-updated'))
      toast.success(t('websearch.apiKeySaved', { defaultValue: 'API key saved securely' }))
    } catch (error) {
      toast.error(
        t('websearch.testFailed', { error: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      setSavingKey(false)
    }
  }, [apiKeyDraft, settings, t])

  const deleteApiKey = useCallback(async () => {
    const status = (await ipcClient.invoke(IPC.WEB_SEARCH_SECRET_DELETE)) as {
      configured: boolean
      suffix: string | null
    }
    setSecretStatus(status)
    setApiKeyDraft('')
    window.dispatchEvent(new Event('ola:web-search-secret-updated'))
  }, [])

  const providerOptions = [
    { value: 'tavily', label: 'Tavily', description: 'AI-powered search API' },
    { value: 'searxng', label: 'Searxng', description: 'Open-source metasearch engine' },
    { value: 'exa', label: 'Exa', description: 'AI search API' },
    { value: 'exa-mcp', label: 'Exa MCP', description: 'Exa via MCP server' },
    { value: 'bocha', label: 'Bocha', description: 'Chinese search engine' },
    { value: 'zhipu', label: 'Zhipu', description: 'ZhiPu AI search' },
    { value: 'google', label: 'Google', description: 'Background crawl in main process' },
    { value: 'bing', label: 'Bing', description: 'Background crawl in main process' },
    { value: 'baidu', label: 'Baidu', description: 'Background crawl in main process' }
  ]

  const handleTestSearch = useCallback(async () => {
    if (!settings.webSearchEnabled) {
      toast.error(t('websearch.disabledError'))
      return
    }

    if (
      !secretStatus.configured &&
      ['tavily', 'searxng', 'exa', 'exa-mcp', 'bocha', 'zhipu'].includes(settings.webSearchProvider)
    ) {
      toast.error(t('websearch.apiKeyRequired'))
      return
    }

    setTesting(true)
    try {
      // Call the actual search API via IPC
      // Provider is determined by user's settings, not passed from AI
      const result = (await ipcClient.invoke(IPC.WEB_SEARCH, {
        query: 'test search query',
        provider: settings.webSearchProvider,
        maxResults: settings.webSearchMaxResults,
        searchMode: 'web',
        timeout: settings.webSearchTimeout
      })) as { error?: string; totalResults?: number }

      if (result.error) {
        toast.error(t('websearch.testFailed', { error: result.error }))
      } else {
        toast.success(t('websearch.testSuccess', { count: result.totalResults || 0 }))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('websearch.testFailed', { error: message }))
    } finally {
      setTesting(false)
    }
  }, [secretStatus.configured, settings, t])

  const isLocalSearch = false
  const requiresApiKey = ['tavily', 'searxng', 'exa', 'exa-mcp', 'bocha', 'zhipu'].includes(
    settings.webSearchProvider
  )

  return (
    <div className={SETTINGS_PANEL_CLASS}>
      <SettingsPageHeader title={t('websearch.title')} description={t('websearch.subtitle')} />

      {/* Enable Web Search */}
      <section className="space-y-3">
        <div className="flex items-center justify-between max-w-lg">
          <div>
            <label className="text-sm font-medium">{t('websearch.enable')}</label>
            <p className="text-xs text-muted-foreground">{t('websearch.enableDesc')}</p>
          </div>
          <Switch
            checked={settings.webSearchEnabled}
            onCheckedChange={(checked) => settings.updateSettings({ webSearchEnabled: checked })}
          />
        </div>
      </section>

      {settings.webSearchEnabled && (
        <>
          <Separator />

          {/* Provider Selection */}
          <section className="space-y-3">
            <div>
              <label className="text-sm font-medium">{t('websearch.provider')}</label>
              <p className="text-xs text-muted-foreground">{t('websearch.providerDesc')}</p>
            </div>
            <Select
              value={settings.webSearchProvider}
              onValueChange={(value) =>
                settings.updateSettings({ webSearchProvider: value as WebSearchProvider })
              }
            >
              <SelectTrigger className="w-full text-xs">
                <SelectValue placeholder={t('websearch.selectProvider')} />
              </SelectTrigger>
              <SelectContent>
                {providerOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value} className="text-xs">
                    <div className="flex flex-col">
                      <span className="font-medium">{option.label}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {option.description}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </section>

          {/* API Key (for non-local providers) */}
          {requiresApiKey && (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium">{t('websearch.apiKey')}</label>
                  <p className="text-xs text-muted-foreground">{t('websearch.apiKeyDesc')}</p>
                </div>
                <Key className="size-4 text-muted-foreground" />
              </div>
              <div className="flex gap-2">
                <Input
                  type="password"
                  placeholder={
                    secretStatus.configured
                      ? `••••${secretStatus.suffix ?? ''}`
                      : t('websearch.apiKeyPlaceholder')
                  }
                  value={apiKeyDraft}
                  onChange={(e) => setApiKeyDraft(e.target.value)}
                />
                <Button size="sm" onClick={saveApiKey} disabled={savingKey || !apiKeyDraft.trim()}>
                  {savingKey ? t('websearch.testing') : t('common.save', { defaultValue: 'Save' })}
                </Button>
                {secretStatus.configured && (
                  <Button size="sm" variant="outline" onClick={() => void deleteApiKey()}>
                    {t('common.delete', { defaultValue: 'Delete' })}
                  </Button>
                )}
              </div>
            </section>
          )}

          {/* Max Results */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium">{t('websearch.maxResults')}</label>
                <p className="text-xs text-muted-foreground">{t('websearch.maxResultsDesc')}</p>
              </div>
              <Hash className="size-4 text-muted-foreground" />
            </div>
            <Input
              type="number"
              min={1}
              max={20}
              value={settings.webSearchMaxResults}
              onChange={(e) =>
                settings.updateSettings({ webSearchMaxResults: parseInt(e.target.value) || 5 })
              }
            />
          </section>

          {/* Timeout */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium">{t('websearch.timeout')}</label>
                <p className="text-xs text-muted-foreground">{t('websearch.timeoutDesc')}</p>
              </div>
              <Clock className="size-4 text-muted-foreground" />
            </div>
            <Input
              type="number"
              min={1000}
              max={120000}
              step={1000}
              value={settings.webSearchTimeout}
              onChange={(e) =>
                settings.updateSettings({ webSearchTimeout: parseInt(e.target.value) || 30000 })
              }
            />
            <div className="flex items-center gap-1">
              {[10000, 30000, 60000, 120000].map((v) => (
                <button
                  key={v}
                  onClick={() => settings.updateSettings({ webSearchTimeout: v })}
                  className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${settings.webSearchTimeout === v ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
                >
                  {v >= 1000 ? `${Math.round(v / 1000)}s` : v}
                </button>
              ))}
            </div>
          </section>

          <Separator />

          {/* Test Button */}
          <section className="space-y-3">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={handleTestSearch}
              disabled={testing}
            >
              <Search className="size-3.5" />
              {testing ? t('websearch.testing') : t('websearch.test')}
            </Button>
            <p className="text-xs text-muted-foreground/70">{t('websearch.testDesc')}</p>
          </section>

          <Separator />

          {/* Configuration Summary */}
          <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
            <h3 className="text-sm font-medium">{t('websearch.configSummary')}</h3>
            <div className="text-xs space-y-1 text-muted-foreground">
              <p>
                <strong>{t('websearch.provider')}:</strong> {settings.webSearchProvider}
              </p>
              {requiresApiKey && (
                <p>
                  <strong>{t('websearch.apiKey')}:</strong>{' '}
                  {secretStatus.configured
                    ? `••••${secretStatus.suffix ?? ''}`
                    : t('websearch.notSet')}
                </p>
              )}
              {isLocalSearch && (
                <p>
                  <strong>{t('websearch.searchEngine')}:</strong> {settings.webSearchEngine}
                </p>
              )}
              <p>
                <strong>{t('websearch.maxResults')}:</strong> {settings.webSearchMaxResults}
              </p>
              <p>
                <strong>{t('websearch.timeout')}:</strong> {settings.webSearchTimeout}ms
              </p>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
