export interface WorkbenchAction {
  id: string
  title: string
  keywords?: string[]
  group?: string
  shortcut?: string
  showInPalette?: boolean
  enabledWhen?: () => boolean
  run: () => void | Promise<void>
}

export interface WorkbenchPane {
  id: string
  title: string
  area: 'main' | 'right' | 'bottom'
}

export interface WorkbenchDrawer {
  id: string
  title: string
  side: 'left' | 'right'
}

type RegistryItem = WorkbenchAction | WorkbenchPane | WorkbenchDrawer
type RegistryKind = 'action' | 'pane' | 'drawer'

const items: Record<RegistryKind, Map<string, RegistryItem>> = {
  action: new Map(),
  pane: new Map(),
  drawer: new Map()
}
const listeners = new Set<() => void>()
let actionSnapshot: WorkbenchAction[] = []

function refreshActionSnapshot(): void {
  actionSnapshot = [...items.action.values()] as WorkbenchAction[]
}

function register<T extends RegistryItem>(kind: RegistryKind, item: T): () => void {
  if (items[kind].has(item.id)) {
    throw new Error(`Workbench ${kind} id is already registered: ${item.id}`)
  }
  items[kind].set(item.id, item)
  if (kind === 'action') refreshActionSnapshot()
  listeners.forEach((listener) => listener())
  return () => {
    if (items[kind].get(item.id) !== item) return
    items[kind].delete(item.id)
    if (kind === 'action') refreshActionSnapshot()
    listeners.forEach((listener) => listener())
  }
}

export const registerWorkbenchAction = (action: WorkbenchAction): (() => void) =>
  register('action', action)
export const registerWorkbenchPane = (pane: WorkbenchPane): (() => void) => register('pane', pane)
export const registerWorkbenchDrawer = (drawer: WorkbenchDrawer): (() => void) =>
  register('drawer', drawer)
export const listWorkbenchActions = (): WorkbenchAction[] =>
  [...items.action.values()] as WorkbenchAction[]
export const getWorkbenchActionsSnapshot = (): WorkbenchAction[] => actionSnapshot
export const getWorkbenchAction = (id: string): WorkbenchAction | undefined =>
  items.action.get(id) as WorkbenchAction | undefined
export const runWorkbenchAction = (id: string): boolean => {
  const action = getWorkbenchAction(id)
  if (!action || (action.enabledWhen && !action.enabledWhen())) return false
  void action.run()
  return true
}
export const listWorkbenchPanes = (): WorkbenchPane[] => [...items.pane.values()] as WorkbenchPane[]
export const listWorkbenchDrawers = (): WorkbenchDrawer[] =>
  [...items.drawer.values()] as WorkbenchDrawer[]
export const subscribeWorkbenchRegistry = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
