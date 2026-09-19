import { BrowserWindow, WebContentsView, webContents, type Rectangle } from 'electron'
import {
  BrowserOwnershipRegistry,
  type BrowserTabOwnership
} from '../../runtime/host/browser-ownership'
import { RuntimeError } from '../../shared/runtime/contracts'

export interface WebContentsViewTabInput {
  tabId: string
  workspaceId: string
  profileId: string
  hostWebContentsId: number
  bounds: Rectangle
  partition?: string
  userAgent?: string
}

export interface WebContentsViewTab {
  tabId: string
  ownership: BrowserTabOwnership
  hostWebContentsId: number
  view: WebContentsView
}

function required(value: string, field: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new RuntimeError(`BROWSER_${field.toUpperCase()}_REQUIRED`)
  return trimmed
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol')
    }
    return url.toString()
  } catch {
    throw new RuntimeError('BROWSER_URL_INVALID')
  }
}

/**
 * Main-owned WebContentsView lifecycle. This is intentionally separate from
 * the transitional <webview> registry so the new host can be enabled per tab
 * and rolled back without weakening ownership checks.
 */
export class WebContentsViewBrowserService {
  private readonly ownership = new BrowserOwnershipRegistry()
  private readonly tabs = new Map<string, WebContentsViewTab>()

  createTab(input: WebContentsViewTabInput): WebContentsViewTab {
    const tabId = required(input.tabId, 'tab_id')
    const workspaceId = required(input.workspaceId, 'workspace_id')
    const profileId = required(input.profileId, 'profile_id')
    const host = webContents.fromId(input.hostWebContentsId)
    const window = host ? BrowserWindow.fromWebContents(host) : null
    if (!host || !window || window.isDestroyed()) {
      throw new RuntimeError('BROWSER_HOST_UNAVAILABLE')
    }
    if (this.tabs.has(tabId)) throw new RuntimeError('BROWSER_TAB_EXISTS')

    const view = new WebContentsView({
      webPreferences: {
        ...(input.partition ? { partition: input.partition } : {}),
        ...(input.userAgent ? { userAgent: input.userAgent } : {}),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    window.contentView.addChildView(view)
    view.setBounds(input.bounds)
    const ownership = this.ownership.register({
      tabId,
      workspaceId,
      profileId,
      createdBy: { kind: 'user', windowId: String(window.id) }
    })
    this.ownership.releaseControl({
      tabId,
      workspaceId,
      controller: { kind: 'user', windowId: String(window.id) }
    })
    const idleOwnership = { ...ownership, controller: null }
    const tab = { tabId, ownership: idleOwnership, hostWebContentsId: host.id, view }
    this.tabs.set(tabId, tab)
    const cleanup = (): void => {
      this.destroyTab(tabId)
    }
    host.once('destroyed', cleanup)
    view.webContents.once('destroyed', cleanup)
    return tab
  }

  setBounds(tabId: string, hostWebContentsId: number, bounds: Rectangle): void {
    const tab = this.requireTab(tabId, hostWebContentsId)
    tab.view.setBounds(bounds)
  }

  async navigate(tabId: string, hostWebContentsId: number, url: string): Promise<void> {
    const tab = this.requireTab(tabId, hostWebContentsId)
    await tab.view.webContents.loadURL(safeUrl(url))
  }

  destroyTab(tabId: string): boolean {
    const tab = this.tabs.get(tabId)
    if (!tab) return false
    this.tabs.delete(tabId)
    const window = BrowserWindow.fromWebContents(webContents.fromId(tab.hostWebContentsId)!)
    if (window && !window.isDestroyed()) window.contentView.removeChildView(tab.view)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    this.ownership.remove(tab.ownership.tabId)
    return true
  }

  private requireTab(tabId: string, hostWebContentsId: number): WebContentsViewTab {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.hostWebContentsId !== hostWebContentsId) {
      throw new RuntimeError('BROWSER_TAB_NOT_FOUND')
    }
    return tab
  }
}
