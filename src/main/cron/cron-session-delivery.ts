import { businessWriteCanary } from '../db/business-write-canary'
import { sendCronWorkspaceEvent } from './cron-workspace-events'

/** Persist once in Main so delivery survives closed or multiple renderer windows. */
export async function deliverCronSessionResult(input: {
  runId: string
  workspaceId: string
  targetSessionId: string | null
  content: string
}): Promise<void> {
  const writer = businessWriteCanary()
  if (!writer) throw new Error('TS_BUSINESS_REPOSITORY_UNAVAILABLE')
  const result = await writer.deliverCronRunToSession({
    ...input,
    createdAt: Date.now()
  })
  if (result.status === 'sent' && result.inserted) {
    sendCronWorkspaceEvent(input.workspaceId, 'cron:session-delivered', {
      runId: input.runId,
      sessionId: input.targetSessionId
    })
  }
}

/** Resume terminal runs that finished after schema v11 but crashed before delivery. */
export async function recoverCronSessionDeliveries(): Promise<void> {
  const writer = businessWriteCanary()
  if (!writer) throw new Error('TS_BUSINESS_REPOSITORY_UNAVAILABLE')
  type Pending = {
    run_id: string
    workspace_id: string
    delivery_target_snapshot: string | null
    source_session_id_snapshot: string | null
    output_summary: string | null
    error: string | null
  }
  let afterRunId = ''
  for (;;) {
    const pending = await writer.pendingCronSessionDeliveries<Pending>(afterRunId)
    if (pending.length === 0) return
    for (const run of pending) {
      afterRunId = run.run_id
      try {
        await deliverCronSessionResult({
          runId: run.run_id,
          workspaceId: run.workspace_id,
          targetSessionId: run.delivery_target_snapshot || run.source_session_id_snapshot,
          content: run.output_summary || run.error || 'Scheduled task finished without output.'
        })
      } catch (error) {
        console.error('[CronDelivery] Failed to recover session delivery:', run.run_id, error)
      }
    }
    if (pending.length < 500) return
  }
}
