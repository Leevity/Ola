import type { SshStore } from '../ssh-store'

export const selectSftpWorkspace = (
  state: SshStore
): Pick<
  SshStore,
  | 'sftpConnections'
  | 'sftpPaneStates'
  | 'sftpCompareMode'
  | 'sftpActivePane'
  | 'sftpConflictPolicy'
  | 'sftpInspectorTab'
> => ({
  sftpConnections: state.sftpConnections,
  sftpPaneStates: state.sftpPaneStates,
  sftpCompareMode: state.sftpCompareMode,
  sftpActivePane: state.sftpActivePane,
  sftpConflictPolicy: state.sftpConflictPolicy,
  sftpInspectorTab: state.sftpInspectorTab
})
