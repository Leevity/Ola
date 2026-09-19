import { quiesceCronSchedulerForHandover } from '../cron/cron-scheduler'
import { quiesceChannelsForHandover, resumeChannelsAfterHandover } from '../channels/auto-reply'
import { getNativeAgentRuntimeManager } from '../ipc/native-agent-runtime'
import { quiesceLegacySyncForHandover } from '../ipc/sync-handlers'
import { parkNativeWorkerForHandover } from '../lib/native-worker'

/**
 * Stops known desktop writers of the legacy business database before a P8
 * snapshot. Deliberately irreversible: a failed handover must not silently
 * reactivate the old scheduler, Agent, or Worker in this process.
 */
export async function quiesceDesktopLegacyBusinessWriter(): Promise<void> {
  await quiesceChannelsForHandover()
  quiesceCronSchedulerForHandover()
  await quiesceLegacySyncForHandover()
  await getNativeAgentRuntimeManager().quiesceForHandover()
  await parkNativeWorkerForHandover()
}

/** Re-enable channel ingress only when the caller has explicitly opted in. */
export async function resumeDesktopTsChannelWriter(): Promise<void> {
  await resumeChannelsAfterHandover()
}
