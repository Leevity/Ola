import { useUIStore } from '@renderer/stores/ui-store'
import { registerWorkbenchAction, registerWorkbenchDrawer, registerWorkbenchPane } from './registry'

let initialized = false

/** Register only Ola-owned affordances; extensions must opt in explicitly. */
export function initializeWorkbenchRegistry(): void {
  if (initialized) return
  initialized = true
  registerWorkbenchAction({
    id: 'workspace.open-tasks',
    title: 'Open task calendar and board',
    keywords: ['tasks', 'kanban', 'gantt'],
    run: () => useUIStore.getState().openTasksPage()
  })
  registerWorkbenchAction({
    id: 'workspace.toggle-right-panel',
    title: 'Toggle workspace details panel',
    keywords: ['panel', 'preview', 'details'],
    run: () => useUIStore.getState().toggleRightPanel()
  })
  registerWorkbenchPane({ id: 'workspace.execution', title: 'Execution', area: 'right' })
  registerWorkbenchPane({ id: 'workspace.preview', title: 'Preview', area: 'right' })
  registerWorkbenchDrawer({ id: 'workspace.sidebar', title: 'Project sidebar', side: 'left' })
}
