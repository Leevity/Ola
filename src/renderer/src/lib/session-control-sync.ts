import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'

export type SessionControlSyncEvent =
  | { kind: 'stop_streaming'; sessionId: string }
  | { kind: 'abort_session'; sessionId: string }

export function emitSessionControlSync(event: SessionControlSyncEvent): void {
  ipcClient.send(IPC.SESSION_CONTROL_SYNC, event)
}

export function installSessionControlSyncListener(
  onEvent: (event: SessionControlSyncEvent) => void
): () => void {
  return ipcClient.on(IPC.SESSION_CONTROL_SYNC, (data: unknown) => {
    onEvent(data as SessionControlSyncEvent)
  })
}
