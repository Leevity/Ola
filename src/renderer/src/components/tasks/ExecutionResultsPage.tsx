import * as React from 'react'
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  Eye,
  Loader2,
  RefreshCw,
  RotateCcw,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type { ExecutionArtifact } from '../../../../shared/execution-artifact'
import type { ExecutionArtifactCategory } from '../../../../shared/execution-artifact'
import { Button } from '@renderer/components/ui/button'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { Input } from '@renderer/components/ui/input'
import {
  hideExecutionArtifact,
  listExecutionArtifacts
} from '@renderer/lib/ipc/execution-artifact-bridge'
import {
  addArtifactFileToDraft,
  addArtifactLinkToDraft,
  addArtifactRemoteFileToDraft
} from '@renderer/lib/execution-artifact-reuse'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { getSessionInputDraftKey, useInputDraftStore } from '@renderer/stores/input-draft-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'

export function ExecutionResultsPage({
  onBack,
  scopeProjectId
}: {
  onBack: () => void
  scopeProjectId?: string
}): React.JSX.Element {
  const { t, i18n } = useTranslation('layout')
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const projects = useChatStore((state) => state.projects)
  const sessions = useChatStore((state) => state.sessions)
  const [projectId, setProjectId] = React.useState('')
  const effectiveProjectId = scopeProjectId ?? projectId
  const [query, setQuery] = React.useState('')
  const [category, setCategory] = React.useState<ExecutionArtifactCategory>('all')
  const [dateRange, setDateRange] = React.useState('all')
  const [createdAfter, setCreatedAfter] = React.useState<number | undefined>()
  const deferredQuery = React.useDeferredValue(query)
  const [artifacts, setArtifacts] = React.useState<ExecutionArtifact[]>([])
  const [nextOffset, setNextOffset] = React.useState<number | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [reusingId, setReusingId] = React.useState<string | null>(null)
  const [hidingId, setHidingId] = React.useState<string | null>(null)
  const requestIdRef = React.useRef(0)
  const availableProjects = React.useMemo(
    () => projects.filter((item) => (item.workspaceId ?? 'local-personal') === workspaceId),
    [projects, workspaceId]
  )

  const loadPage = React.useCallback(
    async (offset: number, append: boolean): Promise<void> => {
      const requestId = ++requestIdRef.current
      setLoading(true)
      setError(null)
      try {
        const page = await listExecutionArtifacts({
          workspaceId,
          ...(effectiveProjectId ? { projectId: effectiveProjectId } : {}),
          ...(deferredQuery.trim() ? { query: deferredQuery.trim() } : {}),
          category,
          ...(createdAfter !== undefined ? { createdAfter } : {}),
          offset,
          limit: 50
        })
        if (requestId !== requestIdRef.current) return
        setArtifacts((current) => (append ? [...current, ...page.artifacts] : page.artifacts))
        setNextOffset(page.nextOffset)
      } catch (cause) {
        if (requestId !== requestIdRef.current) return
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (requestId === requestIdRef.current) setLoading(false)
      }
    },
    [workspaceId, effectiveProjectId, deferredQuery, category, createdAfter]
  )

  React.useEffect(() => {
    const request = requestIdRef
    setArtifacts([])
    setNextOffset(null)
    void loadPage(0, false)
    return () => {
      request.current++
    }
  }, [loadPage])

  React.useEffect(() => setProjectId(''), [workspaceId])

  const openSession = (artifact: ExecutionArtifact): void => {
    const session = sessions.find(
      (item) =>
        item.id === artifact.sessionId && (item.workspaceId ?? 'local-personal') === workspaceId
    )
    if (!session) {
      toast.error(t('executionResults.sessionUnavailable'))
      return
    }
    useChatStore.getState().setActiveSession(session.id)
    useUIStore.getState().navigateToSession(session.id)
  }

  const reuseAsInput = async (artifact: ExecutionArtifact): Promise<void> => {
    if (reusingId) return
    setReusingId(artifact.id)
    try {
      if (artifact.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) {
        throw new Error(t('executionResults.workspaceChanged'))
      }
      const session = useChatStore
        .getState()
        .sessions.find(
          (item) =>
            item.id === artifact.sessionId &&
            (item.workspaceId ?? 'local-personal') === artifact.workspaceId
        )
      if (!session) throw new Error(t('executionResults.sessionUnavailable'))

      if (artifact.kind === 'file') {
        if (
          artifact.transport === 'ssh' &&
          (!artifact.connectionId || session.sshConnectionId !== artifact.connectionId)
        )
          throw new Error(t('executionResults.remoteConnectionMismatch'))
        if (artifact.transport === 'local' && session.sshConnectionId)
          throw new Error(t('executionResults.remoteConnectionMismatch'))
        const stat = (await ipcClient.invoke(
          artifact.transport === 'ssh' ? IPC.SSH_FS_STAT_PATH : IPC.FS_STAT_PATH,
          artifact.transport === 'ssh'
            ? { connectionId: artifact.connectionId, path: artifact.path }
            : { path: artifact.path }
        )) as {
          exists?: boolean
          type?: string | null
          error?: string | null
        }
        if (!stat.exists || stat.type !== 'file') {
          throw new Error(t('executionResults.fileUnavailable'))
        }
      }
      if (artifact.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) {
        throw new Error(t('executionResults.workspaceChanged'))
      }

      const key = getSessionInputDraftKey(session.id)
      const drafts = useInputDraftStore.getState()
      await drafts.hydrateDraft(key)
      if (artifact.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) {
        throw new Error(t('executionResults.workspaceChanged'))
      }
      if (
        !useChatStore
          .getState()
          .sessions.some(
            (item) =>
              item.id === session.id &&
              (item.workspaceId ?? 'local-personal') === artifact.workspaceId
          )
      )
        throw new Error(t('executionResults.sessionUnavailable'))
      const liveSession = useChatStore.getState().sessions.find((item) => item.id === session.id)
      if (
        artifact.kind === 'file' &&
        (liveSession?.sshConnectionId !== session.sshConnectionId ||
          liveSession?.workingFolder !== session.workingFolder)
      )
        throw new Error(t('executionResults.remoteConnectionMismatch'))
      const currentDraft = useInputDraftStore.getState().getDraft(key)
      const { draft, added } =
        artifact.kind === 'link'
          ? addArtifactLinkToDraft(currentDraft, artifact.url)
          : artifact.transport === 'ssh'
            ? addArtifactRemoteFileToDraft(currentDraft, artifact.path)
            : addArtifactFileToDraft(currentDraft, artifact.path, session.workingFolder)
      if (added) await useInputDraftStore.getState().setDraft(key, draft)
      if (artifact.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId)
        throw new Error(t('executionResults.workspaceChanged'))
      useChatStore.getState().setActiveSession(session.id)
      useUIStore.getState().navigateToSession(session.id)
      toast.success(t(added ? 'executionResults.reuseReady' : 'executionResults.alreadyAttached'))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setReusingId(null)
    }
  }

  const removeFromResults = async (artifact: ExecutionArtifact): Promise<void> => {
    if (hidingId) return
    const accepted = await confirm({
      title: t('executionResults.removeConfirmTitle'),
      description: t('executionResults.removeConfirmDescription'),
      confirmLabel: t('executionResults.removeIndex'),
      variant: 'destructive'
    })
    if (!accepted) return
    setHidingId(artifact.id)
    try {
      if (artifact.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) {
        throw new Error(t('executionResults.workspaceChanged'))
      }
      await hideExecutionArtifact({
        workspaceId: artifact.workspaceId,
        runId: artifact.runId,
        seq: artifact.seq
      })
      setArtifacts((current) => current.filter((item) => item.id !== artifact.id))
      toast.success(t('executionResults.removedFromIndex'))
      void loadPage(0, false)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setHidingId(null)
    }
  }

  const dateTime = (timestamp: number): string =>
    new Date(timestamp).toLocaleString(i18n.resolvedLanguage ?? i18n.language)

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            aria-label={t('executionResults.back')}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <h1 className="text-base font-semibold">{t('executionResults.title')}</h1>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void loadPage(0, false)}
          aria-label={t('executionResults.refresh')}
        >
          <RefreshCw className="size-4" />
        </Button>
      </header>
      <div className="flex flex-wrap gap-2 border-b p-4">
        <Input
          className="min-w-56 max-w-sm flex-1"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('executionResults.searchPlaceholder')}
          aria-label={t('executionResults.searchPlaceholder')}
        />
        <select
          className="rounded-md border bg-background px-3 py-2 text-sm"
          value={category}
          onChange={(event) => setCategory(event.target.value as ExecutionArtifactCategory)}
          aria-label={t('executionResults.typeFilter')}
        >
          <option value="all">{t('executionResults.allTypes')}</option>
          <option value="link">{t('executionResults.linkType')}</option>
          <option value="image">{t('executionResults.imageType')}</option>
          <option value="media">{t('executionResults.mediaType')}</option>
          <option value="document">{t('executionResults.documentType')}</option>
          <option value="data">{t('executionResults.dataType')}</option>
          <option value="other">{t('executionResults.otherType')}</option>
        </select>
        <select
          className="rounded-md border bg-background px-3 py-2 text-sm"
          value={dateRange}
          onChange={(event) => {
            const selected = event.target.value
            const days = Number(selected)
            setDateRange(selected)
            setCreatedAfter(days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : undefined)
          }}
          aria-label={t('executionResults.dateFilter')}
        >
          <option value="all">{t('executionResults.anyTime')}</option>
          <option value="1">{t('executionResults.lastDay')}</option>
          <option value="7">{t('executionResults.lastWeek')}</option>
          <option value="30">{t('executionResults.lastMonth')}</option>
        </select>
        {!scopeProjectId && (
          <select
            className="rounded-md border bg-background px-3 py-2 text-sm"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            aria-label={t('executionResults.projectFilter')}
          >
            <option value="">{t('executionResults.allProjects')}</option>
            {availableProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error && (
          <div role="alert" className="mb-3 text-sm text-destructive">
            {t('executionResults.loadFailed')}: {error}
            <Button
              variant="outline"
              size="sm"
              className="ml-2"
              onClick={() => void loadPage(0, false)}
            >
              {t('executionResults.retry')}
            </Button>
          </div>
        )}
        {!loading && !error && artifacts.length === 0 && nextOffset === null && (
          <p className="text-sm text-muted-foreground">{t('executionResults.empty')}</p>
        )}
        <ul className="space-y-2">
          {artifacts.map((artifact) => (
            <li key={artifact.id} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{artifact.title}</p>
                  <p className="break-all text-xs text-muted-foreground">
                    {artifact.kind === 'file' ? artifact.path : artifact.url}
                  </p>
                </div>
                {artifact.kind === 'file' && (
                  <span className="text-xs text-muted-foreground">
                    {artifact.exists
                      ? t('executionResults.present')
                      : t('executionResults.missing')}
                  </span>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{dateTime(artifact.createdAt)}</span>
                <span>
                  {t(
                    artifact.kind === 'link'
                      ? 'executionResults.linkType'
                      : artifact.mediaType?.startsWith('image/')
                        ? 'executionResults.imageType'
                        : artifact.mediaType?.startsWith('audio/') ||
                            artifact.mediaType?.startsWith('video/')
                          ? 'executionResults.mediaType'
                          : 'executionResults.fileType'
                  )}
                </span>
                <span>{t(`executionCenter.status.${artifact.runStatus}`)}</span>
                <span>
                  {availableProjects.find((project) => project.id === artifact.projectId)?.name ??
                    t('executionResults.noProject')}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {artifact.kind === 'file' && artifact.exists && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      useUIStore
                        .getState()
                        .openFilePreview(
                          artifact.path,
                          undefined,
                          artifact.transport === 'ssh' ? artifact.connectionId : undefined,
                          artifact.sessionId
                        )
                    }
                  >
                    <Eye className="mr-1 size-3" />
                    {t('executionResults.preview')}
                  </Button>
                )}
                {(artifact.kind === 'link' || artifact.exists) && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={reusingId !== null}
                    onClick={() => void reuseAsInput(artifact)}
                  >
                    <RotateCcw className="mr-1 size-3" />
                    {t('executionResults.reuseAsInput')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(artifact.kind === 'file' ? artifact.path : artifact.url)
                      .then(() => toast.success(t('executionResults.copied')))
                      .catch(() => toast.error(t('executionResults.copyFailed')))
                  }
                >
                  <Copy className="mr-1 size-3" />
                  {t(
                    artifact.kind === 'file'
                      ? 'executionResults.copyPath'
                      : 'executionResults.copyLink'
                  )}
                </Button>
                {artifact.kind === 'link' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void ipcClient.invoke(IPC.SHELL_OPEN_EXTERNAL, artifact.url)}
                  >
                    <ExternalLink className="mr-1 size-3" />
                    {t('executionResults.openLink')}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => openSession(artifact)}>
                  {t('executionResults.openSession')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={hidingId !== null}
                  onClick={() => void removeFromResults(artifact)}
                >
                  <Trash2 className="mr-1 size-3" />
                  {t('executionResults.removeIndex')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('executionResults.loading')}
          </p>
        )}
        {!loading && nextOffset !== null && (
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => void loadPage(nextOffset, true)}
          >
            {t('executionResults.loadMore')}
          </Button>
        )}
      </div>
    </div>
  )
}
