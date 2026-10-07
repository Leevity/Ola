import { registerWorkbenchDrawer, registerWorkbenchPane } from './registry'

let initialized = false

/** Register only Ola-owned affordances; extensions must opt in explicitly. */
export function initializeWorkbenchRegistry(): void {
  if (initialized) return
  initialized = true
  registerWorkbenchPane({ id: 'workspace.execution', title: 'Execution', area: 'right' })
  registerWorkbenchPane({ id: 'workspace.preview', title: 'Preview', area: 'right' })
  registerWorkbenchDrawer({ id: 'workspace.sidebar', title: 'Project sidebar', side: 'left' })
}
