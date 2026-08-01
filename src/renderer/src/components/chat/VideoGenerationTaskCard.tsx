import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { decodeStructuredToolResult } from '@renderer/lib/tools/tool-result-format'
import type { ToolResultContent } from '@renderer/lib/api/types'
import type { VideoTask } from '../../../../shared/media-runtime'

function parseTaskId(output: ToolResultContent): string | null {
  const outputText =
    typeof output === 'string'
      ? output
      : output
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
  const decoded = decodeStructuredToolResult(outputText)
  if (!decoded || Array.isArray(decoded) || decoded.type !== 'video_generation_task') return null
  return typeof decoded.taskId === 'string' ? decoded.taskId : null
}

export function VideoGenerationTaskCard({
  output
}: {
  output: ToolResultContent
}): React.JSX.Element | null {
  const { t } = useTranslation('layout')
  const taskId = React.useMemo(() => parseTaskId(output), [output])
  const [task, setTask] = React.useState<VideoTask | null>(null)
  const [cancelPending, setCancelPending] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!taskId) return
    let disposed = false
    let timer: number | undefined
    const refresh = async (): Promise<void> => {
      try {
        const tasks = (await ipcClient.invoke('media:tasks-list')) as VideoTask[]
        if (disposed) return
        const next = tasks.find((item) => item.id === taskId) ?? null
        setTask(next)
        setLoadError(null)
        if (!next || ['queued', 'running'].includes(next.state)) {
          timer = window.setTimeout(() => void refresh(), 2500)
        }
      } catch (error) {
        if (disposed) return
        setLoadError(error instanceof Error ? error.message : String(error))
        timer = window.setTimeout(() => void refresh(), 2500)
      }
    }
    void refresh()
    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [taskId])

  if (!taskId) return null
  const state = task?.state ?? 'queued'
  const active = state === 'queued' || state === 'running'
  const cancel = async (): Promise<void> => {
    setCancelPending(true)
    try {
      await ipcClient.invoke('media:task-cancel', { id: taskId })
      const tasks = (await ipcClient.invoke('media:tasks-list')) as VideoTask[]
      setTask(tasks.find((item) => item.id === taskId) ?? null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setCancelPending(false)
    }
  }

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium">
          {t('toolCall.videoGeneration.title', { defaultValue: 'Video generation' })}
        </span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
          {t(`toolCall.videoGeneration.state.${state}`, { defaultValue: state })}
        </span>
        {task ? <span className="ml-auto text-muted-foreground">{task.progress}%</span> : null}
      </div>
      {active ? (
        <div className="h-1.5 overflow-hidden rounded bg-muted">
          <div
            className="h-full bg-primary transition-[width]"
            style={{ width: `${Math.max(3, task?.progress ?? 0)}%` }}
          />
        </div>
      ) : null}
      {task?.outputUrl && state === 'completed' ? (
        <video className="max-h-80 w-full rounded bg-black" controls preload="metadata">
          <source src={`ola-media://${task.id}`} />
        </video>
      ) : null}
      {loadError ? <div className="text-destructive">{loadError}</div> : null}
      {task?.error ? <div className="text-destructive">{task.error}</div> : null}
      {active ? (
        <Button size="sm" variant="outline" disabled={cancelPending} onClick={() => void cancel()}>
          {t('toolCall.videoGeneration.cancel', { defaultValue: 'Cancel task' })}
        </Button>
      ) : null}
    </div>
  )
}
