import type { SshStore } from '../ssh-store'

export const selectSshTransfers = (
  state: SshStore
): Pick<SshStore, 'uploadTasks' | 'transferTasks'> => ({
  uploadTasks: state.uploadTasks,
  transferTasks: state.transferTasks
})
