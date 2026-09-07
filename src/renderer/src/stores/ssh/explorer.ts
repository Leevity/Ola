import type { SshFileEntry } from '../../../../shared/ssh-contract'
import type { SshStore } from '../ssh-store'

export interface SshExplorerSlice {
  fileExplorerOpen: boolean
  fileExplorerPaths: Record<string, string>
  fileExplorerEntries: Record<string, Record<string, SshFileEntry[]>>
  fileExplorerPageInfo: Record<string, Record<string, { cursor?: string; hasMore: boolean }>>
  fileExplorerExpanded: Record<string, Set<string>>
  fileExplorerLoading: Record<string, Record<string, boolean>>
  fileExplorerErrors: Record<string, Record<string, string | null>>
  toggleFileExplorer: () => void
  setFileExplorerPath: (sessionId: string, path: string) => void
  loadFileExplorerEntries: (sessionId: string, path: string, force?: boolean) => Promise<void>
  loadMoreFileExplorerEntries: (sessionId: string, path: string) => Promise<void>
  toggleFileExplorerDir: (sessionId: string, dirPath: string) => void
  setFileExplorerExpanded: (sessionId: string, expanded: string[]) => void
}

export const selectSshExplorer = (
  state: SshStore
): Pick<
  SshStore,
  | 'fileExplorerOpen'
  | 'fileExplorerPaths'
  | 'fileExplorerEntries'
  | 'fileExplorerPageInfo'
  | 'fileExplorerExpanded'
  | 'fileExplorerLoading'
  | 'fileExplorerErrors'
> => ({
  fileExplorerOpen: state.fileExplorerOpen,
  fileExplorerPaths: state.fileExplorerPaths,
  fileExplorerEntries: state.fileExplorerEntries,
  fileExplorerPageInfo: state.fileExplorerPageInfo,
  fileExplorerExpanded: state.fileExplorerExpanded,
  fileExplorerLoading: state.fileExplorerLoading,
  fileExplorerErrors: state.fileExplorerErrors
})
