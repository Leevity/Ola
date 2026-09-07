import type {
  SftpConflictPolicy,
  SftpConnectionState,
  SftpInspectorTab,
  SftpPaneId,
  SftpPaneState,
  SshFileEntry
} from '../../../../shared/ssh-contract'
import type { SshStore } from '../ssh-store'

export interface SshSftpSlice {
  sftpConnections: Record<string, SftpConnectionState>
  sftpPaneStates: Record<SftpPaneId, SftpPaneState>
  sftpCompareMode: boolean
  sftpActivePane: SftpPaneId
  sftpEntries: Record<string, Record<string, SshFileEntry[]>>
  sftpPageInfo: Record<string, Record<string, { cursor?: string; hasMore: boolean }>>
  sftpLoading: Record<string, Record<string, boolean>>
  sftpErrors: Record<string, Record<string, string | null>>
  sftpSelections: Record<SftpPaneId, Record<string, SshFileEntry>>
  sftpConflictPolicy: SftpConflictPolicy
  sftpInspectorTab: SftpInspectorTab
  connectSftpConnection: (connectionId: string) => Promise<{ homeDir?: string | null; error?: string }>
  disconnectSftpConnection: (connectionId: string) => Promise<void>
  setSftpPaneConnection: (paneId: SftpPaneId, connectionId: string | null) => void
  setSftpPanePath: (paneId: SftpPaneId, path: string) => void
  setSftpCompareMode: (enabled: boolean) => void
  setSftpActivePane: (paneId: SftpPaneId) => void
  loadSftpEntries: (connectionId: string, path: string, force?: boolean) => Promise<void>
  loadMoreSftpEntries: (connectionId: string, path: string) => Promise<void>
  setSftpSelection: (paneId: SftpPaneId, entries: SshFileEntry[]) => void
  toggleSftpSelection: (paneId: SftpPaneId, entry: SshFileEntry) => void
  clearSftpSelection: (paneId: SftpPaneId) => void
  setSftpConflictPolicy: (policy: SftpConflictPolicy) => void
  setSftpInspectorTab: (tab: SftpInspectorTab) => void
}

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
