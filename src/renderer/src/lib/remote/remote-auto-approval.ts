import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'

/**
 * Remote-session scoped automatic approval.
 *
 * The main process owns the decision because it is the only process that knows
 * whether a control session is live and how much unattended autonomy has
 * already been spent. The renderer only asks; a failure to answer means "no",
 * so a broken IPC channel can never silently approve a tool call.
 */
export async function bindRunToRemoteSession(runId: string): Promise<void> {
  try {
    await ipcClient.invoke(IPC.REMOTE_ACCESS_BIND_RUN, { runId })
  } catch {
    // No remote session bookkeeping is required for local work.
  }
}

export async function requestRemoteAutoApproval(runId: string, toolName: string): Promise<boolean> {
  try {
    const result = (await ipcClient.invoke(IPC.REMOTE_ACCESS_AUTO_APPROVE, {
      runId,
      toolName
    })) as { approved?: boolean } | null
    return result?.approved === true
  } catch {
    return false
  }
}
