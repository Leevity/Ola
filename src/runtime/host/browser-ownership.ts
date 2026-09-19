import { RuntimeError } from '../../shared/runtime/contracts'

export type BrowserController = { kind: 'user'; windowId: string } | { kind: 'run'; runId: string }

export interface BrowserTabOwnership {
  tabId: string
  workspaceId: string
  profileId: string
  createdBy: BrowserController
  controller: BrowserController | null
}

function sameController(left: BrowserController, right: BrowserController): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'user'
      ? left.windowId === (right as { windowId: string }).windowId
      : left.runId === (right as { runId: string }).runId)
  )
}

/**
 * Pure ownership state shared by the future Main BrowserService and scheduler
 * adapters. It prevents a run from driving a tab after a person takes it over
 * and makes workspace/profile scope an explicit input rather than UI state.
 */
export class BrowserOwnershipRegistry {
  private tabs = new Map<string, BrowserTabOwnership>()

  register(tab: Omit<BrowserTabOwnership, 'controller'>): BrowserTabOwnership {
    if (this.tabs.has(tab.tabId)) throw new RuntimeError('BROWSER_TAB_EXISTS')
    const registered = { ...tab, controller: tab.createdBy }
    this.tabs.set(tab.tabId, registered)
    return { ...registered }
  }

  get(tabId: string): BrowserTabOwnership | null {
    const tab = this.tabs.get(tabId)
    return tab ? { ...tab } : null
  }

  takeControl(input: { tabId: string; workspaceId: string; controller: BrowserController }): {
    tab: BrowserTabOwnership
    displaced: BrowserController | null
  } {
    const tab = this.tabs.get(input.tabId)
    if (!tab) throw new RuntimeError('BROWSER_TAB_NOT_FOUND')
    if (tab.workspaceId !== input.workspaceId) throw new RuntimeError('WORKSPACE_MISMATCH')
    if (tab.controller?.kind === 'user' && input.controller.kind === 'run')
      throw new RuntimeError('BROWSER_USER_IN_CONTROL')
    const displaced =
      tab.controller && !sameController(tab.controller, input.controller) ? tab.controller : null
    tab.controller = input.controller
    return { tab: { ...tab }, displaced }
  }

  releaseControl(input: {
    tabId: string
    workspaceId: string
    controller: BrowserController
  }): void {
    const tab = this.tabs.get(input.tabId)
    if (!tab) throw new RuntimeError('BROWSER_TAB_NOT_FOUND')
    if (tab.workspaceId !== input.workspaceId) throw new RuntimeError('WORKSPACE_MISMATCH')
    if (!tab.controller || !sameController(tab.controller, input.controller))
      throw new RuntimeError('BROWSER_CONTROL_NOT_HELD')
    tab.controller = null
  }

  remove(tabId: string): BrowserTabOwnership | null {
    const tab = this.tabs.get(tabId)
    this.tabs.delete(tabId)
    return tab ? { ...tab } : null
  }
}
