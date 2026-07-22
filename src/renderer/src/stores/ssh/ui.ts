import type { SshStore } from '../ssh-store'

export const selectSshUi = (
  state: SshStore
): Pick<
  SshStore,
  | 'openTabs'
  | 'activeTabId'
  | 'connectionListViewMode'
  | 'workspaceSection'
  | 'detailConnectionId'
  | 'inspectorMode'
> => ({
  openTabs: state.openTabs,
  activeTabId: state.activeTabId,
  connectionListViewMode: state.connectionListViewMode,
  workspaceSection: state.workspaceSection,
  detailConnectionId: state.detailConnectionId,
  inspectorMode: state.inspectorMode
})
