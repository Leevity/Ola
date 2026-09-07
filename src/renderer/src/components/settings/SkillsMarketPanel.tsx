import { useState, useCallback, useEffect } from 'react'
import { CheckCircle2, FolderOpen, Key, RefreshCw, Trash2, Wand2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { useSkillsStore } from '@renderer/stores/skills-store'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Separator } from '@renderer/components/ui/separator'
import { Badge } from '@renderer/components/ui/badge'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { toast } from 'sonner'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'

export function SkillsMarketPanel(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const settings = useSettingsStore()
  const activeTab = useSkillsStore((state) => state.activeTab)
  const skills = useSkillsStore((state) => state.skills)
  const loading = useSkillsStore((state) => state.loading)
  const loadSkills = useSkillsStore((state) => state.loadSkills)
  const setActiveTab = useSkillsStore((state) => state.setActiveTab)
  const deleteSkill = useSkillsStore((state) => state.deleteSkill)
  const openSkillFolder = useSkillsStore((state) => state.openSkillFolder)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  const handleTestConnection = useCallback(async () => {
    setTesting(true)
    try {
      const result = (await ipcClient.invoke('skills:market-list', {
        offset: 0,
        limit: 5,
        query: '',
        provider: 'skillsmp',
        apiKey: settings.skillsMarketApiKey
      })) as { total: number; skills: unknown[] }

      if (result && result.total >= 0) {
        toast.success(t('skillsmarket.testSuccess', { count: result.total }))
      } else {
        toast.error(t('skillsmarket.testFailed', { error: 'No results returned' }))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(t('skillsmarket.testFailed', { error: message }))
    } finally {
      setTesting(false)
    }
  }, [settings, t])

  const handleDeleteSkill = useCallback(
    async (name: string) => {
      const confirmed = await confirm({
        title: t('skillsmarket.deleteTitle', { name, defaultValue: `删除 ${name}` }),
        description: t('skillsmarket.deleteDescription', {
          defaultValue: '删除后将从 Ola 的已安装 Skill 目录中移除。'
        }),
        variant: 'destructive'
      })
      if (!confirmed) return

      const deleted = await deleteSkill(name)
      if (deleted) {
        toast.success(t('skillsmarket.deleteSuccess', { name, defaultValue: `已删除 ${name}` }))
      } else {
        toast.error(t('skillsmarket.deleteFailed', { name, defaultValue: `删除 ${name} 失败` }))
      }
    },
    [deleteSkill, t]
  )

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold">{t('skillsmarket.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('skillsmarket.subtitle')}</p>
      </div>

      <div className="flex items-center gap-1 border-b border-border/60" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'market'}
          className={`border-b-2 px-3 pb-2 text-sm font-medium transition-colors ${
            activeTab === 'market'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('market')}
        >
          {t('skillsmarket.marketTab', { defaultValue: '技能市场' })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'installed'}
          className={`flex items-center gap-2 border-b-2 px-3 pb-2 text-sm font-medium transition-colors ${
            activeTab === 'installed'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('installed')}
        >
          {t('skillsmarket.installedTab', { defaultValue: '已安装' })}
          <Badge variant="secondary" className="h-5 min-w-5 justify-center px-1.5 text-[11px]">
            {skills.length}
          </Badge>
        </button>
      </div>

      {activeTab === 'installed' ? (
        <section className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-medium">
                {t('skillsmarket.installedTitle', { defaultValue: '已安装的 Skill' })}
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('skillsmarket.installedDescription', {
                  defaultValue: '这里展示当前已安装并可被 Ola 动态加载的 Skill。'
                })}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5 text-xs"
              onClick={() => void loadSkills()}
              disabled={loading}
            >
              <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
              {t('skillsmarket.refreshInstalled', { defaultValue: '刷新' })}
            </Button>
          </div>

          {loading ? (
            <div className="rounded-lg border border-border/60 p-6 text-center text-sm text-muted-foreground">
              {t('skillsmarket.loadingInstalled', { defaultValue: '正在加载已安装 Skill…' })}
            </div>
          ) : skills.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <Wand2 className="mx-auto mb-3 size-6 text-muted-foreground" />
              <p className="text-sm font-medium">
                {t('skillsmarket.emptyInstalled', { defaultValue: '暂无已安装 Skill' })}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('skillsmarket.emptyInstalledDescription', {
                  defaultValue: '可以从技能页面安装 Skill，安装后会自动显示在这里。'
                })}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {skills.map((skill) => (
                <div
                  key={skill.name}
                  className="flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-muted/20 p-4"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                      <p className="truncate text-sm font-medium">{skill.name}</p>
                      <Badge variant="outline" className="shrink-0 text-[11px]">
                        {t('skillsmarket.installedBadge', { defaultValue: '已安装' })}
                      </Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {skill.description ||
                        t('skillsmarket.noDescription', { defaultValue: '暂无描述' })}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 text-xs"
                      onClick={() => void openSkillFolder(skill.name)}
                    >
                      <FolderOpen className="size-3.5" />
                      {t('skillsmarket.openFolder', { defaultValue: '打开目录' })}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 text-xs text-destructive hover:text-destructive"
                      onClick={() => void handleDeleteSkill(skill.name)}
                    >
                      <Trash2 className="size-3.5" />
                      {t('skillsmarket.delete', { defaultValue: '删除' })}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : (
        <>
          <Separator />
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium">{t('skillsmarket.apiKey')}</label>
                <p className="text-xs text-muted-foreground">{t('skillsmarket.apiKeyDesc')}</p>
              </div>
              <Key className="size-4 text-muted-foreground" />
            </div>
            <Input
              type="password"
              placeholder={t('skillsmarket.apiKeyPlaceholder')}
              value={settings.skillsMarketApiKey}
              onChange={(e) => settings.updateSettings({ skillsMarketApiKey: e.target.value })}
              className="max-w-sm"
            />
            {/* Info card */}
            <div className="rounded-lg border border-border/60 bg-muted/30 p-4 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Wand2 className="size-4 text-primary" />
                Ola Skills
              </div>
              <p className="text-xs text-muted-foreground">{t('skillsmarket.catalogInfo')}</p>
            </div>
          </section>

          <Separator />

          {/* Test Connection */}
          <section className="space-y-3">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={() => void handleTestConnection()}
              disabled={testing}
            >
              <RefreshCw className={`size-3.5 ${testing ? 'animate-spin' : ''}`} />
              {testing ? t('skillsmarket.testing') : t('skillsmarket.test')}
            </Button>
            <p className="text-xs text-muted-foreground/70">{t('skillsmarket.testDesc')}</p>
          </section>

          <Separator />

          {/* Configuration Summary */}
          <section className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
            <h3 className="text-sm font-medium">{t('skillsmarket.configSummary')}</h3>
            <div className="text-xs space-y-1 text-muted-foreground">
              <p>
                <strong>{t('skillsmarket.provider')}:</strong> Ola Skills
              </p>
              <p>
                <strong>{t('skillsmarket.apiKey')}:</strong>{' '}
                {settings.skillsMarketApiKey ? '********' : t('skillsmarket.notSet')}
              </p>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
