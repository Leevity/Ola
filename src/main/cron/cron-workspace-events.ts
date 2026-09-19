import { safeSendMessagePackToWorkspaceWindows } from '../window-ipc'

export function sendCronWorkspaceEvent(
  workspaceId: string,
  channel: string,
  payload: Record<string, unknown>
): void {
  safeSendMessagePackToWorkspaceWindows(workspaceId, channel, { ...payload, workspaceId })
}
