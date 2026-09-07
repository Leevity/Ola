import type { SshStore } from '../ssh-store'
import type {
  SftpTransferProgress,
  SftpTransferRequest,
  SftpTransferTask,
  SshUploadTask
} from '../../../../shared/ssh-contract'

export function enrichTransferProgress(
  previous: SftpTransferTask | undefined,
  progress: SftpTransferProgress | undefined,
  now: number
): SftpTransferProgress | undefined {
  if (!progress) return undefined
  const current = progress.currentBytes
  const previousBytes = previous?.progress?.currentBytes
  const elapsedSeconds = previous ? (now - previous.updatedAt) / 1000 : 0
  if (
    current === undefined ||
    previousBytes === undefined ||
    current < previousBytes ||
    elapsedSeconds <= 0
  )
    return progress
  const measuredSpeed = (current - previousBytes) / elapsedSeconds
  const priorSpeed = previous?.progress?.speedBytesPerSecond
  const speedBytesPerSecond =
    measuredSpeed > 0
      ? priorSpeed
        ? priorSpeed * 0.65 + measuredSpeed * 0.35
        : measuredSpeed
      : priorSpeed
  const remainingBytes = Math.max(0, (progress.totalBytes ?? current) - current)
  return {
    ...progress,
    speedBytesPerSecond,
    remainingSeconds:
      speedBytesPerSecond && speedBytesPerSecond > 0
        ? remainingBytes / speedBytesPerSecond
        : undefined
  }
}

export const selectSshTransfers = (
  state: SshStore
): Pick<SshStore, 'uploadTasks' | 'transferTasks'> => ({
  uploadTasks: state.uploadTasks,
  transferTasks: state.transferTasks
})
export interface SshTransfersSlice {
  uploadTasks: Record<string, SshUploadTask>
  transferTasks: Record<string, SftpTransferTask>
  startUpload: (args: { connectionId: string; remoteDir: string; localPath: string; kind?: 'file' | 'folder' }) => Promise<string | null>
  cancelUpload: (taskId: string) => Promise<void>
  clearUploadTask: (taskId: string) => void
  startTransfer: (args: SftpTransferRequest) => Promise<string | null>
  retryTransfer: (taskId: string) => Promise<string | null>
  pauseTransfer: (taskId: string) => Promise<void>
  cancelTransfer: (taskId: string) => Promise<void>
  clearTransferTask: (taskId: string) => void
}
