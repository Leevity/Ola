import {
  clampLeftSidebarWidth,
  clampRightPanelWidth,
  clampWorkingFolderPanelWidth
} from '@renderer/components/layout/right-panel-defs'

export interface WorkspaceLayoutSnapshot {
  leftSidebarOpen: boolean
  leftSidebarWidth: number
  rightPanelOpen: boolean
  rightPanelWidth: number
  workingFolderSheetOpen: boolean
  workingFolderPanelWidth: number
  conversationPanelFullWidth: boolean
}

export type WorkspaceLayoutState = WorkspaceLayoutSnapshot

const DEFAULT_LAYOUT_WINDOW_SCOPE = 'primary'

/**
 * A logical window scope survives Electron window-id changes across application restarts.
 * Main assigns it when creating a primary, SSH, or detached-session window.
 */
export function getLayoutWindowScope(search?: string): string {
  const locationSearch = search ?? (typeof window === 'undefined' ? '' : window.location.search)
  const scope = new URLSearchParams(locationSearch).get('layoutWindowScope')
  return scope?.trim() || DEFAULT_LAYOUT_WINDOW_SCOPE
}

export function workspaceLayoutStorageKey(
  workspaceId: string,
  windowScope = getLayoutWindowScope()
): string {
  return `window:${encodeURIComponent(windowScope)}:workspace:${encodeURIComponent(workspaceId)}`
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Reject malformed persisted state before it can affect a workspace's UI. */
export function isWorkspaceLayoutSnapshot(value: unknown): value is WorkspaceLayoutSnapshot {
  if (!value || typeof value !== 'object') return false
  const layout = value as Record<string, unknown>
  return (
    typeof layout.leftSidebarOpen === 'boolean' &&
    isFiniteNumber(layout.leftSidebarWidth) &&
    typeof layout.rightPanelOpen === 'boolean' &&
    isFiniteNumber(layout.rightPanelWidth) &&
    typeof layout.workingFolderSheetOpen === 'boolean' &&
    isFiniteNumber(layout.workingFolderPanelWidth) &&
    typeof layout.conversationPanelFullWidth === 'boolean'
  )
}

export function captureWorkspaceLayout(state: WorkspaceLayoutState): WorkspaceLayoutSnapshot {
  return {
    leftSidebarOpen: state.leftSidebarOpen,
    leftSidebarWidth: clampLeftSidebarWidth(state.leftSidebarWidth),
    rightPanelOpen: state.rightPanelOpen,
    rightPanelWidth: clampRightPanelWidth(state.rightPanelWidth),
    workingFolderSheetOpen: state.workingFolderSheetOpen,
    workingFolderPanelWidth: clampWorkingFolderPanelWidth(state.workingFolderPanelWidth),
    conversationPanelFullWidth: state.conversationPanelFullWidth
  }
}

/**
 * Returns a safe snapshot to apply or null when persisted state cannot be trusted.
 * Widths are normalized at restore time too because viewport bounds may have changed.
 */
export function restoreWorkspaceLayout(value: unknown): WorkspaceLayoutSnapshot | null {
  if (!isWorkspaceLayoutSnapshot(value)) return null
  return captureWorkspaceLayout(value)
}
