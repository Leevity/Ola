import * as React from 'react'
import { FileOutput } from 'lucide-react'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import { openLocalFilePath } from '@renderer/lib/preview/viewers/markdown-components'

function getArtifactPaths(output: string): string[] {
  const result = decodeStructuredToolResult(output)
  if (!result || Array.isArray(result)) return []
  const candidates = [result.artifacts, result.outputFiles, result.createdFiles]
  const paths = candidates.flatMap((candidate) => (Array.isArray(candidate) ? candidate : []))
  return [
    ...new Set(
      paths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    )
  ]
}

export function BashArtifactsCard({ output }: { output: string }): React.JSX.Element | null {
  const paths = React.useMemo(() => getArtifactPaths(output), [output])
  if (paths.length === 0) return null

  return (
    <div className="space-y-1.5" data-bash-artifacts>
      {paths.map((path) => (
        <button
          key={path}
          type="button"
          className="flex w-full items-center gap-2 rounded-md border border-border/55 bg-muted/15 px-2.5 py-2 text-left text-xs hover:bg-muted/35"
          title={path}
          onClick={() => void openLocalFilePath(path)}
        >
          <FileOutput className="size-3.5 shrink-0 text-emerald-500" />
          <span className="min-w-0 flex-1 truncate font-mono">{path}</span>
        </button>
      ))}
    </div>
  )
}
