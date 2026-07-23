import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Search, Trash2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { agentBridge } from '@renderer/lib/ipc/agent-bridge'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'

type Status = {
  success: boolean
  indexed: boolean
  indexing: boolean
  state?: string | null
  fileCount: number
  nodeCount: number
  edgeCount: number
  stale: boolean
  error?: string | null
}
type Stats = {
  success: boolean
  filesByLanguage: Array<{ key: string; count: number }>
}
type SearchResult = { success: boolean; text: string; isError: boolean }
type FilesTree = {
  success: boolean
  files: Array<{ path: string; language: string; nodeCount: number; size: number }>
}
type Analytics = {
  success: boolean
  circularDependencies: Array<{ files: string[] }>
  circularTotal: number
  deadCode: Array<{ id: string; name: string; kind: string; filePath: string; startLine: number }>
  deadCodeTotal: number
}
type ProjectList = {
  success: boolean
  projects: Array<{
    root: string
    hash: string
    state: string
    files: number
    nodes: number
    edges: number
    dbSizeBytes: number
    lastIndexedAt?: number | null
  }>
  error?: string | null
}
type WorkerStatus = {
  running: boolean
  workerReady: boolean
  workerPath?: string | null
  grammarsDir?: string | null
  grammarStatus?: { expected: number; available: number; missing: string[] }
  generation?: number
}
function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB']
  let size = value / 1024
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

type Subgraph = {
  success: boolean
  nodes: Array<{ id: string; name?: string; kind?: string; filePath?: string }>
  edges: Array<{ source: string; target: string; kind?: string }>
}

export function CodeGraphDashboard(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const activeProjectId = useChatStore((state) => state.activeProjectId)
  const projectPath = useChatStore(
    (state) => state.projects.find((project) => project.id === activeProjectId)?.workingFolder
  )
  const [status, setStatus] = useState<Status | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [files, setFiles] = useState<FilesTree['files']>([])
  const [analytics, setAnalytics] = useState<Analytics | null>(null)
  const [query, setQuery] = useState('')
  const [searchResult, setSearchResult] = useState('')
  const [subgraph, setSubgraph] = useState<Subgraph | null>(null)
  const [busy, setBusy] = useState(false)
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus | null>(null)
  const [projects, setProjects] = useState<ProjectList['projects']>([])
  const [syncingProject, setSyncingProject] = useState<string | null>(null)
  const [removingProject, setRemovingProject] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [indexProgress, setIndexProgress] = useState<{
    phase?: string
    processed?: number
    total?: number
  } | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!projectPath) return
    const params = { workingFolder: projectPath }
    setRefreshError(null)
    const nextWorkerStatus = (await ipcClient.invoke(IPC.CODEGRAPH_STATUS)) as WorkerStatus
    setWorkerStatus(nextWorkerStatus)
    if (!nextWorkerStatus.workerReady) return
    try {
      const [nextStatus, nextStats, nextProjects, nextFiles, nextAnalytics] = await Promise.all([
        agentBridge.requestCodeGraph<Status>('codegraph/index-status', params, 10_000),
        agentBridge.requestCodeGraph<Stats>('codegraph/stats', params, 10_000),
        agentBridge.requestCodeGraph<ProjectList>('codegraph/list-projects', {}, 10_000),
        agentBridge.requestCodeGraph<FilesTree>('codegraph/files-tree', params, 10_000),
        agentBridge.requestCodeGraph<Analytics>('codegraph/analytics', params, 10_000)
      ])
      setStatus(nextStatus)
      setStats(nextStats)
      setProjects(nextProjects.success ? nextProjects.projects : [])
      setFiles(nextFiles.success ? nextFiles.files : [])
      setAnalytics(nextAnalytics.success ? nextAnalytics : null)
      setWorkerStatus({ ...nextWorkerStatus, running: true })
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : String(error))
    }
  }, [projectPath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(
    () =>
      ipcClient.on(IPC.CODEGRAPH_INDEX_PROGRESS, (payload) => {
        if (payload && typeof payload === 'object') {
          setIndexProgress(payload as { phase?: string; processed?: number; total?: number })
        }
      }),
    []
  )

  const indexProject = async (): Promise<void> => {
    if (!projectPath) return
    setBusy(true)
    try {
      await agentBridge.requestCodeGraph(
        'codegraph/index',
        { workingFolder: projectPath },
        30 * 60_000
      )
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const syncProject = async (workingFolder: string): Promise<void> => {
    setSyncingProject(workingFolder)
    setRefreshError(null)
    try {
      await agentBridge.requestCodeGraph('codegraph/sync', { workingFolder }, 5 * 60_000)
      await refresh()
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : t('plugin.codegraph.syncFailed'))
    } finally {
      setSyncingProject(null)
    }
  }

  const removeProjectIndex = async (project: ProjectList['projects'][number]): Promise<void> => {
    const label = project.root || project.hash
    if (!window.confirm(t('plugin.codegraph.removeIndexConfirm', { project: label }))) return

    setRemovingProject(project.hash)
    setRefreshError(null)
    try {
      await agentBridge.requestCodeGraph('codegraph/remove-project', {
        ...(project.root ? { workingFolder: project.root } : { hash: project.hash })
      })
      await refresh()
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : String(error))
    } finally {
      setRemovingProject(null)
    }
  }

  const searchSymbols = async (): Promise<void> => {
    if (!projectPath || !query.trim()) return
    const result = await agentBridge.requestCodeGraph<SearchResult>('codegraph/search', {
      workingFolder: projectPath,
      query: query.trim()
    })
    setSearchResult(result.text || '')
  }

  const inspectRelation = async (method: 'codegraph/callers' | 'codegraph/callees') => {
    if (!projectPath || !query.trim()) return
    const result = await agentBridge.requestCodeGraph<SearchResult>(method, {
      workingFolder: projectPath,
      symbol: query.trim()
    })
    setSearchResult(result.text || '')
    const graph = await agentBridge.requestCodeGraph<Subgraph>('codegraph/query-neighbors', {
      workingFolder: projectPath,
      symbol: query.trim(),
      depth: 1,
      limit: 80
    })
    setSubgraph(graph)
  }

  const openSourcePath = (path: string): void => {
    if (!projectPath) return
    const absolute = path.startsWith('/') ? path : `${projectPath}/${path}`
    useUIStore.getState().openFilePreview(absolute)
  }

  if (!projectPath) {
    return (
      <div className="rounded-xl border p-4 text-xs text-muted-foreground">
        {t('plugin.codegraph.noProject')}
      </div>
    )
  }

  return (
    <section className="space-y-4 rounded-xl border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{t('plugin.codegraph.dashboard')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{projectPath}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {!workerStatus
              ? t('plugin.codegraph.workerChecking')
              : workerStatus.workerReady
                ? workerStatus.running
                  ? t('plugin.codegraph.workerRunning')
                  : t('plugin.codegraph.workerReady')
                : t('plugin.codegraph.workerMissing')}
          </p>
          {workerStatus?.workerReady ? (
            <div className="mt-1 space-y-1 text-xs text-muted-foreground">
              <p>
                {workerStatus.grammarStatus?.missing.length === 0
                  ? t('plugin.codegraph.grammarReady', {
                      available: workerStatus.grammarStatus.available,
                      expected: workerStatus.grammarStatus.expected
                    })
                  : t('plugin.codegraph.grammarMissing', {
                      missing: workerStatus.grammarStatus?.missing.length ?? 0,
                      expected: workerStatus.grammarStatus?.expected ?? 0
                    })}
              </p>
              {typeof workerStatus.generation === 'number' ? (
                <p>
                  {t('plugin.codegraph.workerGeneration', { generation: workerStatus.generation })}
                </p>
              ) : null}
            </div>
          ) : null}
          {refreshError ? <p className="mt-1 text-xs text-destructive">{refreshError}</p> : null}
          {indexProgress ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {indexProgress.phase || t('plugin.codegraph.indexing')} ·{' '}
              {indexProgress.processed ?? 0}/{indexProgress.total ?? '?'}
            </p>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="size-3.5" />
            {t('plugin.codegraph.refresh')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!status?.indexed || syncingProject === projectPath}
            onClick={() => void syncProject(projectPath)}
          >
            {syncingProject === projectPath
              ? t('plugin.codegraph.syncing')
              : t('plugin.codegraph.sync')}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void indexProject()}>
            {busy ? t('plugin.codegraph.indexing') : t('plugin.codegraph.index')}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {(['fileCount', 'nodeCount', 'edgeCount'] as const).map((key) => (
          <div key={key} className="rounded-lg bg-muted/30 p-3">
            <div className="text-lg font-semibold">{status?.[key] ?? 0}</div>
            <div className="text-xs text-muted-foreground">{t(`plugin.codegraph.${key}`)}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {(stats?.filesByLanguage || []).map((item) => (
          <span key={item.key} className="rounded-full bg-muted px-2.5 py-1 text-xs">
            {item.key} · {item.count}
          </span>
        ))}
      </div>

      <div className="space-y-2 rounded-lg border p-3">
        <p className="text-xs font-medium">{t('plugin.codegraph.indexedProjects')}</p>
        {projects.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('plugin.codegraph.noIndexedProjects')}</p>
        ) : (
          <div className="space-y-2">
            {projects.map((project) => (
              <div key={project.hash} className="rounded-md bg-muted/30 p-2.5">
                <p className="truncate text-xs font-medium">{project.root || project.hash}</p>
                <div className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                  <p>{t('plugin.codegraph.projectState', { state: project.state })}</p>
                  <p>
                    {project.files} · {project.nodes} · {project.edges}
                  </p>
                  <p>
                    {t('plugin.codegraph.indexSize', { size: formatBytes(project.dbSizeBytes) })}
                  </p>
                  {project.lastIndexedAt ? (
                    <p>
                      {t('plugin.codegraph.lastIndexed', {
                        value: new Intl.DateTimeFormat(undefined, {
                          dateStyle: 'medium',
                          timeStyle: 'short'
                        }).format(new Date(project.lastIndexedAt))
                      })}
                    </p>
                  ) : null}
                </div>
                <div className="mt-2 flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!project.root || syncingProject === project.root}
                    onClick={() => void syncProject(project.root)}
                  >
                    {syncingProject === project.root
                      ? t('plugin.codegraph.syncing')
                      : t('plugin.codegraph.sync')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={removingProject === project.hash}
                    onClick={() => void removeProjectIndex(project)}
                  >
                    <Trash2 className="size-3.5" />
                    {t('plugin.codegraph.removeIndex')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2 rounded-lg border p-3">
        <p className="text-xs font-medium">{t('plugin.codegraph.indexedFiles')}</p>
        {files.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('plugin.codegraph.noIndexedFiles')}</p>
        ) : (
          <div className="max-h-48 space-y-1 overflow-auto">
            {files.slice(0, 12).map((file) => (
              <button
                key={file.path}
                type="button"
                className="block w-full rounded px-1.5 py-1 text-left text-xs hover:bg-muted"
                onClick={() => openSourcePath(file.path)}
              >
                <span className="block truncate font-medium">{file.path}</span>
                <span className="text-[11px] text-muted-foreground">
                  {t('plugin.codegraph.fileDetails', {
                    language: file.language,
                    symbols: file.nodeCount,
                    size: formatBytes(file.size)
                  })}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {analytics ? (
        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-xs font-medium">{t('plugin.codegraph.analytics')}</p>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>
              {t('plugin.codegraph.circularDependencies', { count: analytics.circularTotal })}
            </span>
            <span>{t('plugin.codegraph.deadCode', { count: analytics.deadCodeTotal })}</span>
          </div>
          {analytics.circularDependencies.slice(0, 3).map((cycle, index) => (
            <p
              key={`${index}-${cycle.files.join('/')}`}
              className="truncate text-[11px] text-muted-foreground"
            >
              {cycle.files.join(' → ')}
            </p>
          ))}
          {analytics.deadCode.slice(0, 6).map((symbol) => (
            <button
              key={symbol.id}
              type="button"
              className="block text-left text-[11px] text-muted-foreground hover:underline"
              onClick={() => openSourcePath(symbol.filePath)}
            >
              {symbol.name} · {symbol.kind} · {symbol.filePath}:{symbol.startLine}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && void searchSymbols()}
          placeholder={t('plugin.codegraph.searchPlaceholder')}
        />
        <Button variant="outline" onClick={() => void searchSymbols()}>
          <Search className="size-4" />
        </Button>
        <Button variant="outline" onClick={() => void inspectRelation('codegraph/callers')}>
          {t('plugin.codegraph.callers')}
        </Button>
        <Button variant="outline" onClick={() => void inspectRelation('codegraph/callees')}>
          {t('plugin.codegraph.callees')}
        </Button>
      </div>
      {searchResult ? (
        <div className="max-h-56 overflow-auto rounded-lg bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap">
          {searchResult.split('\n').map((line, index) => {
            const path = line.match(/(?:^|\s)([^\s:]+\.[a-z0-9]+):\d+/i)?.[1]
            return path ? (
              <button
                key={`${index}-${line}`}
                type="button"
                className="block text-left hover:underline"
                onClick={() => openSourcePath(path)}
              >
                {line}
              </button>
            ) : (
              <span key={`${index}-${line}`} className="block">
                {line}
              </span>
            )
          })}
        </div>
      ) : null}
      {subgraph?.success && subgraph.nodes.length > 0 ? (
        <div className="rounded-lg border p-3">
          <p className="text-xs font-medium">{t('plugin.codegraph.localGraph')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {subgraph.nodes.map((node) => (
              <button
                key={node.id}
                type="button"
                className="rounded-full bg-muted px-2.5 py-1 text-xs hover:bg-muted/70"
                onClick={() => node.filePath && openSourcePath(node.filePath)}
              >
                {node.name || node.id} · {node.kind || '?'}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t('plugin.codegraph.relationCount', { count: subgraph.edges.length })}
          </p>
        </div>
      ) : null}
    </section>
  )
}
