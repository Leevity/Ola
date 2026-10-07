export type ProjectTerminalDockArea = 'bottom' | 'right'

export const MIN_PROJECT_WORKSPACE_LEFT_WIDTH = 220
export const MAX_PROJECT_WORKSPACE_LEFT_WIDTH = 520
export const DEFAULT_PROJECT_WORKSPACE_LEFT_WIDTH = 300
export const MIN_PROJECT_WORKSPACE_PREVIEW_WIDTH = 220
export const MIN_PROJECT_TERMINAL_DOCK_WIDTH = 180
export const PROJECT_WORKSPACE_FIXED_WIDTH = 44

const MIN_RIGHT_DOCK_WORKSPACE_WIDTH =
  MIN_PROJECT_WORKSPACE_LEFT_WIDTH +
  PROJECT_WORKSPACE_FIXED_WIDTH +
  MIN_PROJECT_WORKSPACE_PREVIEW_WIDTH +
  MIN_PROJECT_TERMINAL_DOCK_WIDTH

export function getProjectTerminalDockLayout(params: {
  workspaceWidth: number
  leftWidth: number
  terminalOpen: boolean
  preferredArea: ProjectTerminalDockArea
}): {
  canMoveRight: boolean
  effectiveArea: ProjectTerminalDockArea
  effectiveLeftWidth: number
} {
  const canMoveRight = params.workspaceWidth >= MIN_RIGHT_DOCK_WORKSPACE_WIDTH
  const effectiveArea =
    params.terminalOpen && params.preferredArea === 'right' && canMoveRight ? 'right' : 'bottom'
  const effectiveLeftWidth =
    effectiveArea === 'right'
      ? Math.min(
          params.leftWidth,
          params.workspaceWidth -
            PROJECT_WORKSPACE_FIXED_WIDTH -
            MIN_PROJECT_WORKSPACE_PREVIEW_WIDTH -
            MIN_PROJECT_TERMINAL_DOCK_WIDTH
        )
      : params.leftWidth

  return { canMoveRight, effectiveArea, effectiveLeftWidth }
}

export function getMaxProjectWorkspaceLeftWidth(
  workspaceWidth: number,
  dockArea: ProjectTerminalDockArea
): number {
  if (dockArea !== 'right') return MAX_PROJECT_WORKSPACE_LEFT_WIDTH
  return Math.min(
    MAX_PROJECT_WORKSPACE_LEFT_WIDTH,
    workspaceWidth -
      PROJECT_WORKSPACE_FIXED_WIDTH -
      MIN_PROJECT_WORKSPACE_PREVIEW_WIDTH -
      MIN_PROJECT_TERMINAL_DOCK_WIDTH
  )
}
