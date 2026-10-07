import * as React from 'react'
import { Activity, FileText, Laptop, Server, Settings2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useProviderStore } from '@renderer/stores/provider-store'
import { useProviderHealthStore } from '@renderer/stores/provider-health-store'
import { useSshStore } from '@renderer/stores/ssh-store'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { cn } from '@renderer/lib/utils'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import {
  readScenarioTemplateDraft,
  saveScenarioTemplateDraft,
  scenarioTemplateDraftKey
} from '@renderer/lib/scenario-template-draft'
import {
  getScenarioProviderObservation,
  isCurrentProjectPreflight,
  isCurrentSshPreflight
} from '@renderer/lib/scenario-preflight'

type ScenarioId = 'project-review' | 'materials-report' | 'ssh-review'

interface FirstSuccessPanelProps {
  hasLocalProject: boolean
  hasRemoteProject: boolean
  sshConnectionId?: string | null
  workingFolder?: string
  onUsePrompt: (prompt: string, scenarioId: ScenarioId) => void
  onOpenTasks: () => void
  onOpenModelSettings: () => void
  onChooseProject: () => void
  onOpenSshConnections: () => void
}

interface ScenarioTemplate {
  id: ScenarioId
  icon: typeof Activity
  title: string
  description: string
  version: number
  permission: string
  output: string
  expectedResult: string
}

export function FirstSuccessPanel({
  hasLocalProject,
  hasRemoteProject,
  sshConnectionId,
  workingFolder,
  onUsePrompt,
  onOpenTasks,
  onOpenModelSettings,
  onChooseProject,
  onOpenSshConnections
}: FirstSuccessPanelProps): React.JSX.Element {
  const { t, i18n } = useTranslation('chat')
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const [activeScenario, setActiveScenario] = React.useState<ScenarioId | null>(null)
  const [scope, setScope] = React.useState('')
  const [materials, setMaterials] = React.useState('')
  const draftContextRef = React.useRef<{ key: string; workspaceId: string } | null>(null)
  React.useLayoutEffect(() => {
    const context = draftContextRef.current
    if (!context || !activeScenario) return
    if (context.workspaceId !== activeWorkspaceId) {
      setActiveScenario(null)
      setScope('')
      setMaterials('')
      return
    }
    saveScenarioTemplateDraft(context.key, { scope, materials })
  }, [activeScenario, activeWorkspaceId, scope, materials])
  const [sshCheckStatus, setSshCheckStatus] = React.useState<
    'idle' | 'checking' | 'ready' | 'failed'
  >('idle')
  const [sshCheckedConnectionId, setSshCheckedConnectionId] = React.useState<string | null>(null)
  const sshCheckRequestRef = React.useRef(0)
  const sshReviewContextRef = React.useRef({ activeWorkspaceId, sshConnectionId, activeScenario })
  React.useLayoutEffect(() => {
    sshReviewContextRef.current = { activeWorkspaceId, sshConnectionId, activeScenario }
  }, [activeWorkspaceId, sshConnectionId, activeScenario])
  React.useEffect(() => {
    sshCheckRequestRef.current += 1
    setSshCheckStatus('idle')
    setSshCheckedConnectionId(null)
  }, [activeScenario, activeWorkspaceId, sshConnectionId])
  const [scopeSaveStatus, setScopeSaveStatus] = React.useState<'idle' | 'saved' | 'failed'>('idle')
  const [hasSavedScope, setHasSavedScope] = React.useState(false)
  const [projectCheckStatus, setProjectCheckStatus] = React.useState<
    'idle' | 'checking' | 'ready' | 'failed'
  >('idle')
  const projectCheckRequestRef = React.useRef(0)
  const [projectCheckAttempt, setProjectCheckAttempt] = React.useState(0)
  const projectReviewContextRef = React.useRef({ activeWorkspaceId, workingFolder })
  React.useLayoutEffect(() => {
    projectReviewContextRef.current = { activeWorkspaceId, workingFolder }
  }, [activeWorkspaceId, workingFolder])
  React.useEffect(() => {
    if (activeScenario !== 'project-review') return
    if (!workingFolder) {
      setProjectCheckStatus('failed')
      return
    }

    const requestId = ++projectCheckRequestRef.current
    const checkedWorkspaceId = activeWorkspaceId
    const checkedFolder = workingFolder
    setProjectCheckStatus('checking')
    void ipcClient
      .invoke(IPC.FS_STAT_PATH, { path: checkedFolder })
      .then((result) => {
        if (
          !isCurrentProjectPreflight({
            requestId,
            currentRequestId: projectCheckRequestRef.current,
            checkedWorkspaceId,
            currentWorkspaceId: projectReviewContextRef.current.activeWorkspaceId,
            checkedFolder,
            currentFolder: projectReviewContextRef.current.workingFolder
          })
        ) {
          return
        }
        const stat = result as { exists?: boolean; type?: string | null; error?: string }
        setProjectCheckStatus(stat.exists && stat.type === 'directory' ? 'ready' : 'failed')
      })
      .catch(() => {
        if (
          isCurrentProjectPreflight({
            requestId,
            currentRequestId: projectCheckRequestRef.current,
            checkedWorkspaceId,
            currentWorkspaceId: projectReviewContextRef.current.activeWorkspaceId,
            checkedFolder,
            currentFolder: projectReviewContextRef.current.workingFolder
          })
        ) {
          setProjectCheckStatus('failed')
        }
      })

    return () => {
      if (requestId === projectCheckRequestRef.current) projectCheckRequestRef.current += 1
    }
  }, [activeScenario, activeWorkspaceId, workingFolder, projectCheckAttempt])
  const providerReady = useProviderStore((state) => {
    const config = state.getActiveProviderConfig()
    return Boolean(
      activeWorkspaceId &&
      config?.model &&
      (config.apiKey.trim().length > 0 || config.requiresApiKey === false)
    )
  })
  const providerHealthRecords = useProviderHealthStore((state) => state.providers)
  const providerHealthLoading = useProviderHealthStore((state) => state.loading)
  const providerHealthLoadError = useProviderHealthStore((state) => state.loadError)
  const providerKey = useProviderStore((state) => {
    const config = state.getActiveProviderConfig()
    return config?.providerId ?? config?.providerBuiltinId
  })
  const providerObservation = getScenarioProviderObservation(providerKey, providerHealthRecords)
  React.useEffect(() => {
    if (activeScenario) void useProviderHealthStore.getState().load()
  }, [activeScenario])

  const templates: ScenarioTemplate[] = [
    {
      id: 'project-review',
      icon: Activity,
      title: t('firstSuccess.projectReviewTitle'),
      description: t('firstSuccess.projectReviewDescription'),
      version: 1,
      permission: t('firstSuccess.projectReviewPermission'),
      output: t('firstSuccess.outputInChat'),
      expectedResult: t('firstSuccess.projectReviewExpectedResult')
    },
    {
      id: 'materials-report',
      icon: FileText,
      title: t('firstSuccess.materialsReportTitle'),
      description: t('firstSuccess.materialsReportDescription'),
      version: 1,
      permission: t('firstSuccess.materialsReportPermission'),
      output: t('firstSuccess.outputInChat'),
      expectedResult: t('firstSuccess.materialsReportExpectedResult')
    },
    {
      id: 'ssh-review',
      icon: Server,
      title: t('firstSuccess.sshReviewTitle'),
      description: t('firstSuccess.sshReviewDescription'),
      version: 1,
      permission: t('firstSuccess.sshReviewPermission'),
      output: t('firstSuccess.outputInChat'),
      expectedResult: t('firstSuccess.sshReviewExpectedResult')
    }
  ]

  const activeTemplate = templates.find((template) => template.id === activeScenario)
  const needsProject = activeScenario === 'project-review'
  const needsSsh = activeScenario === 'ssh-review'
  const hasRequiredWorkspace = needsProject ? hasLocalProject : needsSsh ? hasRemoteProject : true
  const hasRequiredMaterials = activeScenario !== 'materials-report' || Boolean(materials.trim())
  const projectDirectoryReady = !needsProject || projectCheckStatus === 'ready'
  const canPreparePrompt =
    providerReady && hasRequiredWorkspace && hasRequiredMaterials && projectDirectoryReady
  const canStartScenario =
    canPreparePrompt &&
    (!needsSsh || (sshCheckStatus === 'ready' && sshCheckedConnectionId === sshConnectionId))

  const closeScenario = (open: boolean): void => {
    if (!open) setActiveScenario(null)
  }

  const startScenario = (): void => {
    if (!activeScenario || !canStartScenario) return
    const scopeText = scope.trim() || t('firstSuccess.defaultScope')
    const prompt =
      activeScenario === 'project-review'
        ? t('firstSuccess.projectReviewPrompt', {
            folder: workingFolder ?? '',
            scope: scopeText
          })
        : activeScenario === 'materials-report'
          ? t('firstSuccess.materialsReportPrompt', {
              scope: scopeText,
              materials: materials.trim()
            })
          : t('firstSuccess.sshReviewPrompt', { scope: scopeText })
    onUsePrompt(prompt, activeScenario)
    setActiveScenario(null)
  }

  const requiredResourceText = needsProject
    ? t('firstSuccess.localProjectRequired')
    : t('firstSuccess.sshProjectRequired')

  const scopeStorageKey = (scenarioId: ScenarioId): string =>
    `ola.scenario-template.v${templates.find((template) => template.id === scenarioId)?.version ?? 1}:${encodeURIComponent(activeWorkspaceId)}:${scenarioId}`

  const openScenario = (scenarioId: ScenarioId): void => {
    const key = scenarioTemplateDraftKey(
      activeWorkspaceId,
      scenarioId,
      templates.find((template) => template.id === scenarioId)?.version ?? 1
    )
    const recovered = readScenarioTemplateDraft(key)
    draftContextRef.current = { key, workspaceId: activeWorkspaceId }
    setMaterials(recovered?.materials ?? '')
    setSshCheckStatus('idle')
    setSshCheckedConnectionId(null)
    setProjectCheckStatus(scenarioId === 'project-review' ? 'checking' : 'idle')
    setScopeSaveStatus('idle')
    try {
      const savedScope = window.localStorage.getItem(scopeStorageKey(scenarioId))
      setScope(recovered?.scope ?? savedScope ?? '')
      setHasSavedScope(Boolean(savedScope))
    } catch {
      setScope(recovered?.scope ?? '')
      setHasSavedScope(false)
    }
    setActiveScenario(scenarioId)
  }

  const saveScope = (): void => {
    if (!activeScenario || !scope.trim()) return
    try {
      window.localStorage.setItem(scopeStorageKey(activeScenario), scope.trim())
      setHasSavedScope(true)
      setScopeSaveStatus('saved')
    } catch {
      setScopeSaveStatus('failed')
    }
  }

  const removeSavedScope = (): void => {
    if (!activeScenario) return
    try {
      window.localStorage.removeItem(scopeStorageKey(activeScenario))
      setHasSavedScope(false)
      setScopeSaveStatus('idle')
    } catch {
      setScopeSaveStatus('failed')
    }
  }

  return (
    <>
      <section
        className="mt-5 rounded-xl border border-border/60 bg-muted/10 p-3"
        aria-label={t('firstSuccess.title')}
      >
        <div className="mb-3 flex items-center gap-2">
          <Laptop className="size-4 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-medium">{t('firstSuccess.title')}</h2>
            <p className="text-[13px] text-muted-foreground">{t('firstSuccess.subtitle')}</p>
          </div>
        </div>
        <div className="grid gap-2 md:grid-cols-3">
          {templates.map((template) => {
            const Icon = template.icon
            return (
              <button
                key={template.id}
                type="button"
                data-testid={`first-success-template-${template.id}`}
                onClick={() => openScenario(template.id)}
                className="rounded-lg border border-border/60 bg-background/45 p-3 text-left transition-colors hover:bg-muted/60"
              >
                <div className="flex items-center gap-2">
                  <Icon className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{template.title}</span>
                </div>
                <p className="mt-1.5 text-[13px] leading-5 text-muted-foreground">
                  {template.description}
                </p>
                <span className="mt-2 inline-block text-xs font-medium text-primary">
                  {t('firstSuccess.configureTemplate')}
                </span>
              </button>
            )
          })}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/50 pt-3">
          <p className="text-xs text-muted-foreground">{t('firstSuccess.taskCenterHint')}</p>
          <Button variant="outline" size="sm" onClick={onOpenTasks}>
            {t('firstSuccess.openTasks')}
          </Button>
        </div>
      </section>

      <Dialog open={activeScenario !== null} onOpenChange={closeScenario}>
        <DialogContent className="max-w-2xl" data-testid="first-success-template-dialog">
          <DialogHeader>
            <DialogTitle>{activeTemplate?.title}</DialogTitle>
            <DialogDescription>{activeTemplate?.description}</DialogDescription>
          </DialogHeader>

          {activeTemplate && (
            <div className="grid gap-2 rounded-lg border bg-muted/20 p-3 text-xs sm:grid-cols-2">
              <p>
                <span className="font-medium">{t('firstSuccess.templateVersion')}:</span> v
                {activeTemplate.version}
              </p>
              <p>
                <span className="font-medium">{t('firstSuccess.permissionLevel')}:</span>{' '}
                {activeTemplate.permission}
              </p>
              <p>
                <span className="font-medium">{t('firstSuccess.defaultOutput')}:</span>{' '}
                {activeTemplate.output}
              </p>
              <p>
                <span className="font-medium">{t('firstSuccess.expectedResult')}:</span>{' '}
                {activeTemplate.expectedResult}
              </p>
            </div>
          )}

          <div className="space-y-4">
            {activeScenario === 'materials-report' && (
              <label className="block space-y-1.5 text-sm font-medium">
                {t('firstSuccess.materialsLabel')}
                <Textarea
                  value={materials}
                  data-testid="first-success-template-materials"
                  onChange={(event) => setMaterials(event.target.value)}
                  className="min-h-32 resize-y font-normal"
                  placeholder={t('firstSuccess.materialsPlaceholder')}
                />
              </label>
            )}
            <label className="block space-y-1.5 text-sm font-medium">
              {t('firstSuccess.scopeLabel')}
              <Textarea
                value={scope}
                data-testid="first-success-template-scope"
                onChange={(event) => setScope(event.target.value)}
                className="min-h-20 resize-y font-normal"
                placeholder={t('firstSuccess.scopePlaceholder')}
              />
            </label>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {t('firstSuccess.saveScopeHint')}
                {scopeSaveStatus === 'saved' ? ` ${t('firstSuccess.scopeSaved')}` : ''}
                {scopeSaveStatus === 'failed' ? ` ${t('firstSuccess.scopeSaveFailed')}` : ''}
              </p>
              <div className="flex gap-2">
                {hasSavedScope && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="first-success-template-remove-scope"
                    onClick={removeSavedScope}
                  >
                    {t('firstSuccess.removeSavedScope')}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="first-success-template-save-scope"
                  disabled={!scope.trim()}
                  onClick={saveScope}
                >
                  {t('firstSuccess.saveScope')}
                </Button>
              </div>
            </div>

            <div className="space-y-2 rounded-lg border p-3 text-sm">
              <p className="font-medium">{t('firstSuccess.preflightTitle')}</p>
              <PreflightRow ready={providerReady} label={t('firstSuccess.modelReady')} />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>{t('firstSuccess.providerObservation')}</span>
                <span
                  className={cn(
                    'text-xs',
                    providerObservation?.status === 'healthy'
                      ? 'text-emerald-600'
                      : providerObservation?.status === 'down'
                        ? 'text-destructive'
                        : providerObservation
                          ? 'text-amber-600'
                          : 'text-muted-foreground'
                  )}
                >
                  {providerHealthLoading && !providerHealthRecords.length
                    ? t('firstSuccess.providerHealth.loading')
                    : providerHealthLoadError
                      ? t('firstSuccess.providerHealth.unavailable')
                      : t(
                          `firstSuccess.providerHealth.${providerObservation?.status ?? 'notObserved'}`
                        )}
                  {providerObservation
                    ? ` · ${new Intl.DateTimeFormat(i18n.language, {
                        hour: '2-digit',
                        minute: '2-digit'
                      }).format(
                        Math.max(
                          providerObservation.lastSucceededAt ?? 0,
                          providerObservation.lastFailedAt ?? 0
                        )
                      )}`
                    : ''}
                </span>
              </div>
              {needsProject || needsSsh ? (
                <PreflightRow ready={hasRequiredWorkspace} label={requiredResourceText} />
              ) : null}
              {needsProject && hasRequiredWorkspace ? (
                <PreflightRow
                  ready={projectCheckStatus === 'ready'}
                  label={t(`firstSuccess.projectCheck.${projectCheckStatus}`)}
                />
              ) : null}
              {needsSsh && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{t('firstSuccess.sshConnection')}</span>
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'text-xs',
                        sshCheckStatus === 'ready'
                          ? 'text-emerald-600'
                          : sshCheckStatus === 'failed'
                            ? 'text-destructive'
                            : 'text-muted-foreground'
                      )}
                    >
                      {t(`firstSuccess.sshCheck.${sshCheckStatus}`)}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={
                        !sshConnectionId || !hasRequiredWorkspace || sshCheckStatus === 'checking'
                      }
                      onClick={() => {
                        if (!sshConnectionId) return
                        const requestId = ++sshCheckRequestRef.current
                        const checkedWorkspaceId = activeWorkspaceId
                        const checkedConnectionId = sshConnectionId
                        const isCurrent = (): boolean =>
                          isCurrentSshPreflight({
                            requestId,
                            currentRequestId: sshCheckRequestRef.current,
                            checkedWorkspaceId,
                            currentWorkspaceId: sshReviewContextRef.current.activeWorkspaceId,
                            checkedConnectionId,
                            currentConnectionId: sshReviewContextRef.current.sshConnectionId,
                            scenarioOpen:
                              sshReviewContextRef.current.activeScenario === 'ssh-review'
                          })
                        setSshCheckStatus('checking')
                        setSshCheckedConnectionId(null)
                        void useSshStore
                          .getState()
                          .testConnection(checkedConnectionId)
                          .then((result) => {
                            if (!isCurrent()) return
                            setSshCheckStatus(result.success ? 'ready' : 'failed')
                            if (result.success) setSshCheckedConnectionId(checkedConnectionId)
                          })
                          .catch(() => {
                            if (isCurrent()) setSshCheckStatus('failed')
                          })
                      }}
                    >
                      {sshCheckStatus === 'checking'
                        ? t('firstSuccess.sshCheck.testing')
                        : t('firstSuccess.sshCheck.action')}
                    </Button>
                  </div>
                </div>
              )}
              {activeScenario === 'materials-report' ? (
                <PreflightRow
                  ready={Boolean(materials.trim())}
                  label={t('firstSuccess.materialsReady')}
                />
              ) : null}
              {(!providerReady || providerObservation?.status === 'down') && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={onOpenModelSettings}
                >
                  <Settings2 className="mr-1 size-3.5" />
                  {t('firstSuccess.openModelSettings')}
                </Button>
              )}
              {!hasRequiredWorkspace && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {needsProject
                      ? t('firstSuccess.chooseLocalProject')
                      : t('firstSuccess.chooseSshProject')}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setActiveScenario(null)
                      if (needsProject) onChooseProject()
                      else onOpenSshConnections()
                    }}
                  >
                    {t(
                      needsProject ? 'firstSuccess.configureProject' : 'firstSuccess.configureSsh'
                    )}
                  </Button>
                </div>
              )}
              {needsSsh && sshCheckStatus === 'failed' && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setActiveScenario(null)
                    onOpenSshConnections()
                  }}
                >
                  {t('firstSuccess.configureSsh')}
                </Button>
              )}
              {needsProject && projectCheckStatus === 'failed' && hasRequiredWorkspace && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setProjectCheckAttempt((value) => value + 1)}
                  >
                    {t('firstSuccess.recheckProject')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setActiveScenario(null)
                      onChooseProject()
                    }}
                  >
                    {t('firstSuccess.configureProject')}
                  </Button>
                </div>
              )}
            </div>

            {needsProject && projectCheckStatus === 'failed' && (
              <p className="text-xs text-destructive">
                {t('firstSuccess.projectCheck.failedHint')}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t('firstSuccess.reviewBeforeSend')}</p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setActiveScenario(null)}>
              {t('firstSuccess.cancel')}
            </Button>
            <Button
              data-testid="first-success-template-use-prompt"
              onClick={startScenario}
              disabled={!canStartScenario}
            >
              {t('firstSuccess.usePrompt')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function PreflightRow({ ready, label }: { ready: boolean; label: string }): React.JSX.Element {
  const { t } = useTranslation('chat')
  return (
    <div className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <span className={cn('text-xs', ready ? 'text-emerald-600' : 'text-destructive')}>
        {ready ? t('firstSuccess.ready') : t('firstSuccess.missing')}
      </span>
    </div>
  )
}
