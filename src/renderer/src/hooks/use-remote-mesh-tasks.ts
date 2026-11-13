import { useCallback, useEffect, useRef, useState } from 'react'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { currentRemoteTaskSnapshot } from '@renderer/lib/remote/remote-task-progress'
import { useChatStore } from '@renderer/stores/chat-store'
import { useRemoteAccountStore } from '@renderer/stores/remote-account-store'
import { useRuntimeProjectionStore } from '@renderer/stores/runtime-projection-store'
import type { RemoteMeshTask, RemoteTaskDecision } from '../../../shared/remote-control'

/**
 * Executes Mesh tasks this desktop admitted.
 *
 * The main process owns the inbox and the admission decision; this hook only
 * polls it and runs what was admitted. A task is claimed once per window, and
 * main refuses a second claim, so two windows cannot both execute one request.
 *
 * The agent loop is imported dynamically: this hook is mounted at the app root,
 * and a static import would put the whole chat pipeline into first paint.
 */

const POLL_INTERVAL_MS = 5_000
/** The projection caps assistant text at 4000 chars; 3000 stays under 12 KiB even for 4-byte code points. */
const RESULT_TEXT_CHARS = 3000
const TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'canceled'])

export function useRemoteMeshTasks(enabled: boolean): {
  tasks: RemoteMeshTask[]
  decidingTaskId: string | null
  decide: (taskId: string, accept: boolean) => Promise<RemoteTaskDecision | null>
} {
  const [tasks, setTasks] = useState<RemoteMeshTask[]>([])
  const [decidingTaskId, setDecidingTaskId] = useState<string | null>(null)
  const loadMeshTaskEvents = useRemoteAccountStore((state) => state.loadMeshTaskEvents)
  const cursor = useRef(0)
  const claimed = useRef(new Set<string>())
  const polling = useRef(false)

  const execute = useCallback(async (task: RemoteMeshTask): Promise<void> => {
    const previousActive = useChatStore.getState().activeSessionId
    const sessionId = useChatStore
      .getState()
      .createSession('chat', null, { preserveProjectless: true })
    // createSession activates what it creates. A remote task must not move the
    // local user's view while they are working in another session.
    if (previousActive && previousActive !== sessionId) {
      useChatStore.getState().setActiveSession(previousActive)
    }

    let reported = false
    let started = false
    const report = (outcome: 'completed' | 'failed'): void => {
      if (reported) return
      reported = true
      const projection = useRuntimeProjectionStore.getState().projections[sessionId]
      const snapshot = currentRemoteTaskSnapshot()
      const text =
        outcome === 'completed' && snapshot && snapshot.runId === projection?.runId
          ? snapshot.text.trim().slice(0, RESULT_TEXT_CHARS)
          : ''
      void ipcClient
        .invoke(IPC.REMOTE_TASK_FINISH, {
          taskId: task.taskId,
          outcome,
          ...(text ? { resultText: text } : {})
        })
        .catch(() => undefined)
    }

    const unsubscribe = useRuntimeProjectionStore.subscribe((state) => {
      const projection = state.projections[sessionId]
      if (!projection?.runId) return
      if (!started) {
        started = true
        void ipcClient
          .invoke(IPC.REMOTE_TASK_STARTED, { taskId: task.taskId, runId: projection.runId })
          .catch(() => undefined)
      }
      if (TERMINAL_STATUSES.has(projection.status)) {
        unsubscribe()
        report(
          projection.status === 'completed' || projection.status === 'partial'
            ? 'completed'
            : 'failed'
        )
      }
    })

    try {
      const { sendChatMessage } = await import('@renderer/lib/agent/chat-send-message')
      await sendChatMessage(task.text, undefined, undefined, sessionId)
      // Backstop: the projection can be cleared before a terminal status is
      // observed, and a task left running in main would hold its session open.
      report('completed')
    } catch {
      report('failed')
    } finally {
      unsubscribe()
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    if (polling.current) return
    polling.current = true
    try {
      try {
        // Feeds main's inbox: verified dispatches are recorded there, and only
        // receipts come back here.
        const result = await loadMeshTaskEvents(cursor.current)
        cursor.current = Math.max(cursor.current, result.nextCursor)
      } catch {
        // Keep the cursor; the next bounded poll can recover.
      }
      const result = (await ipcClient.invoke(IPC.REMOTE_TASK_LIST)) as {
        tasks?: RemoteMeshTask[]
      } | null
      const next = result?.tasks ?? []
      setTasks(next)
      for (const task of next) {
        if (task.status !== 'admitted' || claimed.current.has(task.taskId)) continue
        claimed.current.add(task.taskId)
        void execute(task)
      }
    } catch {
      // An unreachable inbox is not an error the user can act on.
    } finally {
      polling.current = false
    }
  }, [execute, loadMeshTaskEvents])

  useEffect(() => {
    if (!enabled) return undefined
    void refresh()
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [enabled, refresh])

  const decide = useCallback(
    async (taskId: string, accept: boolean): Promise<RemoteTaskDecision | null> => {
      setDecidingTaskId(taskId)
      try {
        const decision = (await ipcClient.invoke(IPC.REMOTE_TASK_DECIDE, {
          taskId,
          accept
        })) as RemoteTaskDecision | null
        await refresh()
        return decision
      } catch {
        return null
      } finally {
        setDecidingTaskId(null)
      }
    },
    [refresh]
  )

  return { tasks, decidingTaskId, decide }
}
