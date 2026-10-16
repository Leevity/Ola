import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Send, Smartphone } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { useRemoteAccountStore } from '@renderer/stores/remote-account-store'

export function MobileMeshWorkspace(): React.JSX.Element {
  const { t } = useTranslation('layout')
  const token = useRemoteAccountStore((state) => state.token)
  const account = useRemoteAccountStore((state) => state.account)
  const device = useRemoteAccountStore((state) => state.device)
  const devices = useRemoteAccountStore((state) => state.devices)
  const meshNodes = useRemoteAccountStore((state) => state.meshNodes)
  const loadDevices = useRemoteAccountStore((state) => state.loadDevices)
  const loadMeshNodes = useRemoteAccountStore((state) => state.loadMeshNodes)
  const sendMeshTask = useRemoteAccountStore((state) => state.sendMeshTask)
  const loadMeshTaskEvents = useRemoteAccountStore((state) => state.loadMeshTaskEvents)
  const [targetNodeId, setTargetNodeId] = useState('')
  const [taskText, setTaskText] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [sending, setSending] = useState(false)
  const [receipt, setReceipt] = useState<{ type: string; resultText?: string } | null>(null)
  const receiptCursor = useRef(0)
  const [lastDispatch, setLastDispatch] = useState<{
    eventId: string
    taskId: string
    sessionId: string
    targetNodeId: string
  } | null>(null)

  const mobileNodes = useMemo(
    () =>
      meshNodes
        .filter(
          (node) =>
            node.deviceId !== device?.id &&
            (node.platform === 'android' || node.platform === 'ios') &&
            node.capabilities.some((capability) => capability.id === 'task.execute')
        )
        .map((node) => ({
          ...node,
          online: devices.some((item) => item.id === node.deviceId && item.isOnline)
        })),
    [device?.id, devices, meshNodes]
  )

  const refresh = useCallback(async (): Promise<void> => {
    if (!token) return
    setRefreshing(true)
    try {
      await Promise.all([loadDevices(), loadMeshNodes()])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('remote.mobileRefreshFailed'))
    } finally {
      setRefreshing(false)
    }
  }, [loadDevices, loadMeshNodes, t, token])

  useEffect(() => {
    void refresh()
  }, [account?.id, refresh])

  useEffect(() => {
    if (!mobileNodes.some((node) => node.nodeId === targetNodeId)) {
      setTargetNodeId(
        mobileNodes.find((node) => node.online)?.nodeId ?? mobileNodes[0]?.nodeId ?? ''
      )
    }
  }, [mobileNodes, targetNodeId])

  const selectedNode = mobileNodes.find((node) => node.nodeId === targetNodeId)
  const textBytes = new TextEncoder().encode(taskText.trim()).byteLength
  const canSend = Boolean(
    token && selectedNode?.online && taskText.trim() && textBytes <= 12 * 1024
  )

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!selectedNode || !canSend) return
    setSending(true)
    setLastDispatch(null)
    try {
      const result = await sendMeshTask(selectedNode.nodeId, taskText)
      setLastDispatch(result)
      setReceipt(null)
      receiptCursor.current = 0
      toast.success(t('remote.mobileTaskSent'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('remote.mobileTaskSendFailed'))
    } finally {
      setSending(false)
    }
  }

  useEffect(() => {
    if (!lastDispatch || !token || !device) return
    let disposed = false
    const poll = async (): Promise<void> => {
      try {
        const result = await loadMeshTaskEvents(receiptCursor.current)
        if (disposed) return
        receiptCursor.current = Math.max(receiptCursor.current, result.nextCursor)
        const matching = result.events
          .filter(
            (event) =>
              event.sessionId === lastDispatch.sessionId &&
              event.payload.task_id === lastDispatch.taskId
          )
          .sort((left, right) => right.sequence - left.sequence)[0]
        if (matching) {
          setReceipt({
            type: matching.type,
            resultText: matching.payload.result_text
          })
          if (
            [
              'task.completed',
              'task.failed',
              'task.rejected',
              'task.cancelled',
              'task.expired'
            ].includes(matching.type)
          ) {
            window.clearInterval(timer)
          }
        }
      } catch {
        // Keep the current receipt state; the next bounded poll can recover.
      }
    }
    const timer = window.setInterval(() => void poll(), 2500)
    void poll()
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [device, lastDispatch, loadMeshTaskEvents, token])

  return (
    <section className="mx-auto flex h-full w-full max-w-4xl flex-col gap-6 overflow-y-auto p-6 md:p-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Smartphone className="size-5" />
          </span>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t('remote.crossPlatform')}
            </p>
            <h1 className="mt-1 text-xl font-semibold">{t('remote.mobileTitle')}</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              {t('remote.mobileDescription')}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          disabled={!token || refreshing}
        >
          <RefreshCw className={`mr-2 size-4 ${refreshing ? 'animate-spin' : ''}`} />
          {t('remote.refreshMobileNodes')}
        </Button>
      </header>

      {!token ? (
        <div className="rounded-xl border bg-card p-5 text-sm text-muted-foreground">
          {t('remote.mobileLoginRequired')}
        </div>
      ) : mobileNodes.length === 0 ? (
        <div className="rounded-xl border bg-card p-5">
          <h2 className="font-medium">{t('remote.noMobileNodes')}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t('remote.noMobileNodesHint')}</p>
        </div>
      ) : (
        <form
          onSubmit={(event) => void submit(event)}
          className="space-y-5 rounded-xl border bg-card p-5"
        >
          <div className="space-y-2">
            <label htmlFor="mesh-mobile-target" className="text-sm font-medium">
              {t('remote.mobileTarget')}
            </label>
            <select
              id="mesh-mobile-target"
              value={targetNodeId}
              onChange={(event) => setTargetNodeId(event.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {mobileNodes.map((node) => {
                const mobileDevice = devices.find((item) => item.id === node.deviceId)
                return (
                  <option key={node.nodeId} value={node.nodeId}>
                    {mobileDevice?.deviceName ?? node.platform} ·{' '}
                    {node.online ? t('remote.online') : t('remote.offline')}
                  </option>
                )
              })}
            </select>
            {selectedNode && !selectedNode.online ? (
              <p className="text-xs text-amber-600">{t('remote.mobileNodeMustBeOnline')}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <label htmlFor="mesh-mobile-task" className="text-sm font-medium">
              {t('remote.mobileTaskPrompt')}
            </label>
            <Textarea
              id="mesh-mobile-task"
              value={taskText}
              onChange={(event) => setTaskText(event.target.value)}
              placeholder={t('remote.mobileTaskPlaceholder')}
              rows={5}
              disabled={!selectedNode?.online || sending}
              aria-describedby="mesh-mobile-task-note"
            />
            <p id="mesh-mobile-task-note" className="text-xs text-muted-foreground">
              {t('remote.mobileTaskApprovalNote')} · {textBytes.toLocaleString()} / 12,288 bytes
            </p>
          </div>

          <div className="flex justify-end">
            <Button type="submit" disabled={!canSend || sending}>
              <Send className="mr-2 size-4" />
              {sending ? t('remote.mobileTaskSending') : t('remote.sendMobileTask')}
            </Button>
          </div>

          {lastDispatch ? (
            <div className="rounded-lg border border-emerald-600/30 bg-emerald-600/5 p-4 text-sm">
              <p className="font-medium text-emerald-700 dark:text-emerald-400">
                {receipt
                  ? t(`remote.mobileReceipt.${receipt.type}`, { defaultValue: receipt.type })
                  : t('remote.mobileTaskQueued')}
              </p>
              {receipt?.resultText ? (
                <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                  {receipt.resultText}
                </p>
              ) : null}
              <dl className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                <div>
                  <dt className="font-medium">Task ID</dt>
                  <dd className="break-all font-mono">{lastDispatch.taskId}</dd>
                </div>
                <div>
                  <dt className="font-medium">Event ID</dt>
                  <dd className="break-all font-mono">{lastDispatch.eventId}</dd>
                </div>
              </dl>
            </div>
          ) : null}
        </form>
      )}
    </section>
  )
}
