import { useEffect, useState } from 'react'
import { MousePointer2, Play, Save, Square, Trash2, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import type {
  DesktopFlow,
  DesktopFlowRecordingStatus,
  DesktopFlowReplayResult
} from '../../../../shared/desktop-flow'

export function DesktopAutomationPanel(): React.JSX.Element {
  const [name, setName] = useState('Desktop flow')
  const [status, setStatus] = useState<DesktopFlowRecordingStatus | null>(null)
  const [current, setCurrent] = useState<DesktopFlow | null>(null)
  const [flows, setFlows] = useState<DesktopFlow[]>([])
  const [captureText, setCaptureText] = useState(false)
  const [replaying, setReplaying] = useState(false)
  const [lastReplay, setLastReplay] = useState<DesktopFlowReplayResult | null>(null)

  async function refresh(): Promise<void> {
    setStatus((await ipcClient.invoke('desktop-recorder:status')) as DesktopFlowRecordingStatus)
    setCurrent((await ipcClient.invoke('desktop-recorder:current')) as DesktopFlow | null)
    setFlows((await ipcClient.invoke('desktop-flow:list')) as DesktopFlow[])
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function start(): Promise<void> {
    await ipcClient.invoke('desktop-recorder:start', { name, captureText })
    await refresh()
  }

  async function stopAndSave(): Promise<void> {
    const flow = (await ipcClient.invoke('desktop-recorder:stop')) as DesktopFlow | null
    if (flow) await ipcClient.invoke('desktop-flow:save', flow)
    await refresh()
  }

  async function replay(flow: DesktopFlow): Promise<void> {
    const highRisk = flow.steps.some((step) => step.riskLevel === 'high')
    if (highRisk && !window.confirm('This flow contains high-risk actions. Continue?')) return
    setReplaying(true)
    try {
      const result = (await ipcClient.invoke('desktop-flow:replay', {
        flow,
        approved: highRisk,
        verifyScreenshots: true
      })) as DesktopFlowReplayResult
      setLastReplay(result)
    } finally {
      setReplaying(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <header>
        <div className="flex items-center gap-2">
          <MousePointer2 className="size-5 text-primary" />
          <h2 className="text-xl font-semibold">Desktop Automation</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Record and replay local desktop actions. Text capture is disabled by default to avoid
          storing passwords.
        </p>
      </header>
      <div className="flex flex-wrap gap-2">
        <Input
          className="min-w-[220px] flex-1"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button disabled={Boolean(status?.recording)} onClick={() => void start()}>
          <Play className="mr-2 size-4" /> Start
        </Button>
        <Button
          variant="destructive"
          disabled={!status?.recording}
          onClick={() => void stopAndSave()}
        >
          <Square className="mr-2 size-4" /> Stop & Save
        </Button>
      </div>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={captureText}
          onChange={(event) => setCaptureText(event.target.checked)}
        />
        Store typed text in the flow (avoid passwords)
      </label>
      {status ? (
        <p className="text-xs text-muted-foreground">
          {status.recording ? 'Recording' : 'Idle'} · {status.stepCount} steps
        </p>
      ) : null}
      {lastReplay ? (
        <p className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
          {lastReplay.success
            ? `Replay completed · ${lastReplay.receipts?.filter((receipt) => receipt.changed).length ?? 0} steps changed the screen`
            : `Replay stopped: ${lastReplay.error ?? 'Unknown error'}`}
        </p>
      ) : null}
      {current ? (
        <p className="rounded-md border bg-muted/20 p-3 text-sm">Current flow: {current.name}</p>
      ) : null}
      <div className="space-y-2">
        {replaying ? (
          <Button
            variant="destructive"
            onClick={() => void ipcClient.invoke('desktop-flow:cancel')}
          >
            <X className="mr-2 size-4" /> Cancel replay
          </Button>
        ) : null}
        {flows.map((flow) => (
          <div key={flow.id} className="flex items-center gap-2 rounded-lg border p-3">
            <span className="min-w-0 flex-1 truncate text-sm">
              {flow.name} · {flow.steps.length} steps
            </span>
            <Button size="sm" variant="outline" onClick={() => void replay(flow)}>
              <Play className="mr-1 size-3" />
              Run
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={async () => {
                await ipcClient.invoke('desktop-flow:delete', { id: flow.id })
                await refresh()
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </div>
      {!flows.length ? (
        <p className="text-sm text-muted-foreground">No saved desktop flows yet.</p>
      ) : null}
      {current && !status?.recording ? (
        <Button
          variant="secondary"
          onClick={() => void ipcClient.invoke('desktop-flow:save', current).then(refresh)}
        >
          <Save className="mr-2 size-4" />
          Save current flow
        </Button>
      ) : null}
    </div>
  )
}
