import type { SshStore } from '../ssh-store'

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
