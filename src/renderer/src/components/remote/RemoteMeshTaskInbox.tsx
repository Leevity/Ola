import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ListChecks } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useRemoteAccountStore } from '@renderer/stores/remote-account-store'
import { useRemoteMeshTasks } from '@renderer/hooks/use-remote-mesh-tasks'
import type { RemoteTaskRejection } from '../../../../shared/remote-control'

/**
 * App-level inbox for Mesh tasks addressed to this desktop.
 *
 * It lives next to the remote-control badge rather than inside the remote page
 * because an unattended machine has nobody looking at any page: the request has
 * to be answerable from wherever the user happens to be.
 */
export function RemoteMeshTaskInbox(): React.JSX.Element | null {
  const { t } = useTranslation('layout')
  const token = useRemoteAccountStore((state) => state.token)
  const deviceId = useRemoteAccountStore((state) => state.device?.id)
  const remoteAccessMode = useRemoteAccountStore((state) => state.remoteAccessMode)
  const { tasks, decidingTaskId, decide } = useRemoteMeshTasks(
    Boolean(token && deviceId && remoteAccessMode !== 'none')
  )
  const [refusal, setRefusal] = useState<{ taskId: string; reason: RemoteTaskRejection } | null>(
    null
  )

  const pending = tasks.filter((task) => task.status === 'pending')
  const running = tasks.filter((task) => task.status === 'running' || task.status === 'admitted')
  if (pending.length === 0 && running.length === 0 && !refusal) return null

  const answer = async (taskId: string, accept: boolean): Promise<void> => {
    const decision = await decide(taskId, accept)
    if (!decision) {
      setRefusal({ taskId, reason: 'unknown-task' })
      return
    }
    setRefusal(decision.accepted ? null : { taskId, reason: decision.reason })
  }

  return (
    <div className="pointer-events-auto fixed bottom-24 right-4 z-50 flex w-80 flex-col gap-2">
      {refusal ? (
        <p className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {t(`remote.meshTaskReason.${refusal.reason}`)}
        </p>
      ) : null}
      {running.length > 0 ? (
        <p className="rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground shadow-lg">
          {t('remote.meshTaskRunning', { running: running.length })}
        </p>
      ) : null}
      {pending.slice(0, 3).map((task) => (
        <div
          key={task.taskId}
          className="rounded-lg border bg-card p-3 shadow-lg"
          role="alertdialog"
          aria-label={t('remote.meshTaskTitle')}
        >
          <div className="flex items-start gap-2">
            <ListChecks className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium">{t('remote.meshTaskTitle')}</p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {t('remote.meshTaskFrom', { node: task.sourceNodeId })}
              </p>
            </div>
          </div>
          <p className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-xs">
            {task.text}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">{t('remote.meshTaskAttendedNote')}</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={decidingTaskId === task.taskId}
              onClick={() => void answer(task.taskId, false)}
            >
              {t('remote.meshTaskReject')}
            </Button>
            <Button
              size="sm"
              disabled={decidingTaskId === task.taskId}
              onClick={() => void answer(task.taskId, true)}
            >
              {t('remote.meshTaskAccept')}
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
