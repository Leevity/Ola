import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, Download, FolderOpen, RefreshCw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { useChatStore } from '@renderer/stores/chat-store'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'
import type { ProjectWikiDocument } from '../../../../shared/project-wiki'

interface ProjectWikiPanelProps {
  projectRoot?: string | null
  embedded?: boolean
}

export function ProjectWikiPanel({
  projectRoot: controlledProjectRoot,
  embedded = false
}: ProjectWikiPanelProps = {}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const activeProjectId = useChatStore((state) => state.activeProjectId)
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const activeProjectRoot = useChatStore(
    (state) => state.projects.find((project) => project.id === activeProjectId)?.workingFolder
  )
  const [projectRoot, setProjectRoot] = useState('')
  const [document, setDocument] = useState<ProjectWikiDocument | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function resolveAndLoad(): Promise<void> {
      let nextProjectRoot = controlledProjectRoot
      if (nextProjectRoot === undefined) {
        nextProjectRoot = activeProjectRoot
        if (!nextProjectRoot) {
          const result = (await ipcClient.invoke('fs:default-chat-working-folder')) as {
            path?: string
          }
          nextProjectRoot = result.path
        }
      }

      if (cancelled) return
      setProjectRoot(nextProjectRoot ?? '')
      setDocument(null)
      setError(null)
      if (!nextProjectRoot) return

      try {
        const stored = (await ipcClient.invoke('wiki:get', {
          projectRoot: nextProjectRoot,
          workspaceId
        })) as ProjectWikiDocument | null
        if (!cancelled) setDocument(stored)
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }

    void resolveAndLoad()
    return () => {
      cancelled = true
    }
  }, [activeProjectRoot, controlledProjectRoot, workspaceId])

  async function chooseFolder(): Promise<void> {
    const result = (await ipcClient.invoke('fs:select-folder', { defaultPath: projectRoot })) as {
      path?: string
    }
    if (result.path) setProjectRoot(result.path)
  }

  async function generate(force = false): Promise<void> {
    if (!projectRoot.trim()) return
    setBusy(true)
    setError(null)
    try {
      const result = (await ipcClient.invoke('wiki:generate', {
        projectRoot: projectRoot.trim(),
        force,
        workspaceId
      })) as ProjectWikiDocument
      if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) setDocument(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function exportMarkdown(): Promise<void> {
    try {
      const picked = (await ipcClient.invoke('fs:select-save-file', {
        defaultPath: 'project-wiki.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })) as { path?: string }
      if (!picked.path) return
      await ipcClient.invoke('wiki:export', { projectRoot, destination: picked.path, workspaceId })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className={`${embedded ? 'w-full' : 'mx-auto w-full max-w-3xl'} space-y-5`}>
      <header className={embedded ? 'rounded-xl border bg-muted/10 p-4' : undefined}>
        <div className="flex items-center gap-2">
          <BookOpen className="size-5 text-primary" />
          <h3 className="text-sm font-semibold">
            {t('wiki.title', { defaultValue: 'Project Wiki' })}
          </h3>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('wiki.description', {
            defaultValue:
              'Build a local, incremental map of project files and symbols. Sensitive directories are excluded.'
          })}
        </p>
      </header>
      {controlledProjectRoot === undefined ? (
        <div className="flex gap-2">
          <Input
            value={projectRoot}
            onChange={(event) => setProjectRoot(event.target.value)}
            placeholder={t('wiki.projectFolder', { defaultValue: 'Project folder' })}
          />
          <Button
            variant="outline"
            onClick={() => void chooseFolder()}
            title={t('wiki.chooseProjectFolder', { defaultValue: 'Choose project folder' })}
          >
            <FolderOpen className="size-4" />
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || !projectRoot.trim()}
          onClick={() => void generate(false)}
          title={t('wiki.generate', { defaultValue: 'Generate Wiki' })}
        >
          <RefreshCw className={`mr-2 size-4 ${busy ? 'animate-spin' : ''}`} />
          {t('wiki.generate', { defaultValue: 'Generate Wiki' })}
        </Button>
        <Button
          variant="secondary"
          disabled={busy || !projectRoot.trim()}
          onClick={() => void generate(true)}
        >
          {t('wiki.rescan', { defaultValue: 'Re-scan' })}
        </Button>
        <Button variant="outline" disabled={!document} onClick={() => void exportMarkdown()}>
          <Download className="mr-2 size-4" />
          {t('wiki.export', { defaultValue: 'Export Markdown' })}
        </Button>
      </div>
      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {document ? (
        <div className="rounded-xl border bg-card p-4">
          <div className="flex justify-between text-sm">
            <span>{document.fileCount} files</span>
            <span className="text-muted-foreground">{document.nodes.length} nodes</span>
          </div>
          <div className="mt-3 max-h-[420px] overflow-auto rounded-md bg-muted/30 p-3 font-mono text-xs">
            {document.nodes.map((node) => (
              <div key={`${node.kind}:${node.path}`} className="py-0.5">
                {node.kind === 'directory' ? '📁' : '📄'} {node.path}
                {node.symbols?.length ? ` — ${node.symbols.slice(0, 8).join(', ')}` : ''}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
