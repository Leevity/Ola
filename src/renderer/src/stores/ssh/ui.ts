import type { SshTab, SshWorkspaceSection } from '../../../../shared/ssh-contract'
import type { SshStore } from '../ssh-store'

export interface SshUiSlice {
  openTabs: SshTab[]
  activeTabId: string | null
  connectionListViewMode: 'table' | 'card'
  workspaceSection: SshWorkspaceSection
  detailConnectionId: string | null
  inspectorMode: 'create' | 'edit'
  setConnectionListViewMode: (mode: 'table' | 'card') => void
  setWorkspaceSection: (section: SshWorkspaceSection) => void
  setDetailConnectionId: (id: string | null) => void
  setInspectorMode: (mode: 'create' | 'edit') => void
  openTab: (tab: SshTab) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string | null) => void
  replaceTab: (tabId: string, tab: SshTab) => void
}

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
