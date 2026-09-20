import { quiesceCronSchedulerForHandover } from '../cron/cron-scheduler'
import { quiesceChannelsForHandover, resumeChannelsAfterHandover } from '../channels/auto-reply'
import { quiesceLegacySyncForHandover } from '../ipc/sync-handlers'

/**
 * Stops the remaining legacy writers of the business database before a P8
 * snapshot. Agent execution and persistence are TS-owned; there is no worker
 * process to park during a handover.
 */
export async function quiesceDesktopLegacyBusinessWriter(): Promise<void> {
  await quiesceChannelsForHandover()
  quiesceCronSchedulerForHandover()
  await quiesceLegacySyncForHandover()
}

/** Re-enable channel ingress only when the caller has explicitly opted in. */
export async function resumeDesktopTsChannelWriter(): Promise<void> {
  await resumeChannelsAfterHandover()
}
