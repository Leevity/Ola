import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Search } from 'lucide-react'
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
  const [query, setQuery] = useState('')
  const [searchResult, setSearchResult] = useState('')
  const [subgraph, setSubgraph] = useState<Subgraph | null>(null)
  const [busy, setBusy] = useState(false)
  const [workerStatus, setWorkerStatus] = useState<{
    running: boolean
    workerReady: boolean
  } | null>(null)
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
    const nextWorkerStatus = (await ipcClient.invoke(IPC.CODEGRAPH_STATUS)) as {
      running: boolean
      workerReady: boolean
    }
    setWorkerStatus(nextWorkerStatus)
    if (!nextWorkerStatus.workerReady) return
    try {
      const [nextStatus, nextStats] = await Promise.all([
        agentBridge.requestCodeGraph<Status>('codegraph/index-status', params, 10_000),
        agentBridge.requestCodeGraph<Stats>('codegraph/stats', params, 10_000)
      ])
      setStatus(nextStatus)
      setStats(nextStats)
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
