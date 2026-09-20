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

export interface WebContentsViewNavigationState {
  webContentsId: number
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
}

export type WebContentsViewNavigationEventType =
  | 'did-start-loading'
  | 'did-stop-loading'
  | 'did-navigate'
  | 'did-navigate-in-page'
  | 'page-title-updated'
  | 'did-fail-load'

export interface WebContentsViewNavigationEvent {
  tabId: string
  hostWebContentsId: number
  type: WebContentsViewNavigationEventType
  state: WebContentsViewNavigationState
  error?: { code: number; description: string; url: string }
}

type WebContentsViewNavigationListener = (event: WebContentsViewNavigationEvent) => void

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
  private readonly listeners = new Set<WebContentsViewNavigationListener>()

  onNavigationEvent(listener: WebContentsViewNavigationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

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
    const emit = (
      type: WebContentsViewNavigationEventType,
      error?: { code: number; description: string; url: string }
    ): void => {
      if (!this.tabs.has(tabId)) return
      const event: WebContentsViewNavigationEvent = {
        tabId,
        hostWebContentsId: host.id,
        type,
        state: this.getNavigationState(tabId, host.id),
        ...(error ? { error } : {})
      }
      for (const listener of this.listeners) listener(event)
    }
    view.webContents.on('did-start-loading', () => emit('did-start-loading'))
    view.webContents.on('did-stop-loading', () => emit('did-stop-loading'))
    view.webContents.on('did-navigate', () => emit('did-navigate'))
    view.webContents.on('did-navigate-in-page', () => emit('did-navigate-in-page'))
    view.webContents.on('page-title-updated', () => emit('page-title-updated'))
    view.webContents.on('will-navigate', (event, url) => {
      try {
        safeUrl(url)
      } catch {
        event.preventDefault()
      }
    })
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      if (errorCode === -3) return
      emit('did-fail-load', { code: errorCode, description: errorDescription, url: validatedURL })
    })
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

  async navigate(
    tabId: string,
    hostWebContentsId: number,
    action: 'back' | 'forward' | 'reload' | 'stop' | 'goto',
    url?: string
  ): Promise<WebContentsViewNavigationState> {
    const tab = this.requireTab(tabId, hostWebContentsId)
    if (action === 'goto') {
      if (!url) throw new RuntimeError('BROWSER_URL_REQUIRED')
      await tab.view.webContents.loadURL(safeUrl(url))
    } else if (action === 'back') {
      if (tab.view.webContents.canGoBack()) tab.view.webContents.goBack()
    } else if (action === 'forward') {
      if (tab.view.webContents.canGoForward()) tab.view.webContents.goForward()
    } else if (action === 'reload') {
      tab.view.webContents.reload()
    } else {
      tab.view.webContents.stop()
    }
    return this.getNavigationState(tabId, hostWebContentsId)
  }

  getNavigationState(tabId: string, hostWebContentsId: number): WebContentsViewNavigationState {
    const tab = this.requireTab(tabId, hostWebContentsId)
    return {
      webContentsId: tab.view.webContents.id,
      url: tab.view.webContents.getURL(),
      title: tab.view.webContents.getTitle(),
      canGoBack: tab.view.webContents.canGoBack(),
      canGoForward: tab.view.webContents.canGoForward()
    }
  }

  destroyTab(tabId: string, hostWebContentsId?: number): boolean {
    const tab = this.tabs.get(tabId)
    if (!tab) return false
    if (hostWebContentsId !== undefined && tab.hostWebContentsId !== hostWebContentsId) {
      throw new RuntimeError('BROWSER_TAB_NOT_FOUND')
    }
    this.tabs.delete(tabId)
    const host = webContents.fromId(tab.hostWebContentsId)
    const window = host ? BrowserWindow.fromWebContents(host) : null
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
