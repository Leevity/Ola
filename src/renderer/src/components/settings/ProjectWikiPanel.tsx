import { useEffect, useState } from 'react'
import { BookOpen, Download, FolderOpen, RefreshCw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import type { ProjectWikiDocument } from '../../../../shared/project-wiki'

export function ProjectWikiPanel(): React.JSX.Element {
  const [projectRoot, setProjectRoot] = useState('')
  const [document, setDocument] = useState<ProjectWikiDocument | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const result = (await ipcClient.invoke('fs:default-chat-working-folder')) as { path?: string }
      if (result.path) setProjectRoot(result.path)
    })()
  }, [])

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
        force
      })) as ProjectWikiDocument
      setDocument(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function exportMarkdown(): Promise<void> {
    const picked = (await ipcClient.invoke('fs:select-save-file', {
      defaultPath: 'project-wiki.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })) as { path?: string }
    if (!picked.path) return
    await ipcClient.invoke('wiki:export', { projectRoot, destination: picked.path })
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <header>
        <div className="flex items-center gap-2">
          <BookOpen className="size-5 text-primary" />
          <h2 className="text-xl font-semibold">Project Wiki</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Build a local, incremental map of project files and symbols. Sensitive directories are
          excluded.
        </p>
      </header>
      <div className="flex gap-2">
        <Input
          value={projectRoot}
          onChange={(event) => setProjectRoot(event.target.value)}
          placeholder="Project folder"
        />
        <Button variant="outline" onClick={() => void chooseFolder()} title="Choose project folder">
          <FolderOpen className="size-4" />
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !projectRoot.trim()} onClick={() => void generate(false)}>
          <RefreshCw className={`mr-2 size-4 ${busy ? 'animate-spin' : ''}`} />
          Generate Wiki
        </Button>
        <Button
          variant="secondary"
          disabled={busy || !projectRoot.trim()}
          onClick={() => void generate(true)}
        >
          Re-scan
        </Button>
        <Button variant="outline" disabled={!document} onClick={() => void exportMarkdown()}>
          <Download className="mr-2 size-4" /> Export Markdown
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
