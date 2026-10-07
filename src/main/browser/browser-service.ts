import { BrowserWindow, webContents } from 'electron'
import {
  BrowserOwnershipRegistry,
  type BrowserTabOwnership
} from '../../runtime/host/browser-ownership'
import { RuntimeError } from '../../shared/runtime/contracts'
import { checkBrowserUrlAccess } from './browser-access-policy'

export interface BrowserUserTabRegistration {
  tabId: string
  workspaceId: string
  profileId: string
  hostWebContentsId: number
  guestWebContentsId: number
  sessionId?: string | null
  projectId?: string | null
}

export interface RegisteredBrowserTab {
  ownership: BrowserTabOwnership
  hostWebContentsId: number
  guestWebContentsId: number
  sessionId?: string | null
  projectId?: string | null
}

export type BrowserNavigationAction = 'back' | 'forward' | 'reload' | 'stop' | 'goto'

export interface BrowserNavigationState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
}

export interface BrowserScreenshot {
  data: string
  mediaType: 'image/png'
  width: number
  height: number
}

function safeBrowserUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 8_192) return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function browserNavigationState(guest: Electron.WebContents): BrowserNavigationState {
  return {
    url: guest.getURL(),
    title: guest.getTitle(),
    canGoBack: guest.canGoBack(),
    canGoForward: guest.canGoForward()
  }
}

function requireText(value: string, field: string): void {
  if (!value.trim()) throw new RuntimeError(`BROWSER_${field.toUpperCase()}_REQUIRED`)
}

/**
 * Main owns the association between a browser guest and its workspace. The
 * current renderer <webview> is only a transitional view host: it cannot make
 * a guest eligible for secrets or automation until this service verifies its
 * Electron ownership. The same registry will back WebContentsView tabs.
 */
export class MainBrowserService {
  private readonly ownership = new BrowserOwnershipRegistry()
  private readonly tabsById = new Map<string, RegisteredBrowserTab>()
  private readonly tabIdByGuestWebContentsId = new Map<number, string>()
  private readonly navigationPermits = new Set<string>()
  private readonly hostsWithCleanup = new Set<number>()

  registerUserTab(input: BrowserUserTabRegistration): BrowserTabOwnership {
    requireText(input.tabId, 'tab_id')
    requireText(input.workspaceId, 'workspace_id')
    requireText(input.profileId, 'profile_id')

    const host = webContents.fromId(input.hostWebContentsId)
    const guest = webContents.fromId(input.guestWebContentsId)
    const ownerWindow = host ? BrowserWindow.fromWebContents(host) : null
    if (!host || !guest || !ownerWindow || ownerWindow.isDestroyed()) {
      throw new RuntimeError('BROWSER_HOST_UNAVAILABLE')
    }
    if (guest.isDestroyed() || guest.getType() !== 'webview') {
      throw new RuntimeError('BROWSER_GUEST_UNAVAILABLE')
    }
    if (guest.hostWebContents?.id !== host.id) {
      throw new RuntimeError('BROWSER_GUEST_OWNER_MISMATCH')
    }

    const priorTabId = this.tabIdByGuestWebContentsId.get(guest.id)
    if (priorTabId && priorTabId !== input.tabId) {
      throw new RuntimeError('BROWSER_GUEST_ALREADY_REGISTERED')
    }

    const existing = this.tabsById.get(input.tabId)
    if (existing) {
      const isSameRegistration =
        existing.hostWebContentsId === host.id &&
        existing.guestWebContentsId === guest.id &&
        existing.ownership.workspaceId === input.workspaceId &&
        existing.ownership.profileId === input.profileId &&
        existing.sessionId === input.sessionId &&
        existing.projectId === input.projectId
      if (!isSameRegistration) throw new RuntimeError('BROWSER_TAB_EXISTS')
      return { ...existing.ownership }
    }

    const ownership = this.ownership.register({
      tabId: input.tabId,
      workspaceId: input.workspaceId,
      profileId: input.profileId,
      createdBy: { kind: 'user', windowId: String(ownerWindow.id) }
    })
    // Creation only establishes provenance. A user gains the interactive
    // lease on an explicit focus/click, which leaves an idle tab available to
    // a future agent-owned operation without treating it as user-controlled.
    this.ownership.releaseControl({
      tabId: input.tabId,
      workspaceId: input.workspaceId,
      controller: { kind: 'user', windowId: String(ownerWindow.id) }
    })
    this.tabsById.set(input.tabId, {
      ownership,
      hostWebContentsId: host.id,
      guestWebContentsId: guest.id,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {})
    })
    this.tabIdByGuestWebContentsId.set(guest.id, input.tabId)
    const navigationGuard = (event: Electron.Event, targetUrl: string): void => {
      const current = this.tabsById.get(input.tabId)
      const controller = this.ownership.get(input.tabId)?.controller
      if (!current || controller?.kind !== 'run') return
      const normalized = safeBrowserUrl(targetUrl)
      if (!normalized) {
        event.preventDefault()
        return
      }
      const permit = `${input.tabId}\n${normalized}`
      if (this.navigationPermits.delete(permit)) return
      event.preventDefault()
      const runId = controller.runId
      void checkBrowserUrlAccess(normalized, current.projectId)
        .then(async (decision) => {
          const latest = this.tabsById.get(input.tabId)
          const latestController = this.ownership.get(input.tabId)?.controller
          if (
            !decision.allowed ||
            latest !== current ||
            latestController?.kind !== 'run' ||
            latestController.runId !== runId
          )
            return
          this.navigationPermits.add(permit)
          await guest.loadURL(normalized).catch(() => {
            this.navigationPermits.delete(permit)
          })
        })
        .catch(() => undefined)
    }
    guest.on('will-navigate', navigationGuard)
    guest.on('will-redirect', navigationGuard)
    guest.once('destroyed', () => this.remove(input.tabId))
    if (!this.hostsWithCleanup.has(host.id)) {
      this.hostsWithCleanup.add(host.id)
      host.once('destroyed', () => {
        this.removeHostTabs(host.id)
        this.hostsWithCleanup.delete(host.id)
      })
    }
    return { ...ownership }
  }

  takeRegisteredGuestRunControl(input: {
    hostWebContentsId: number
    guestWebContentsId: number
    runId: string
  }): BrowserTabOwnership {
    const tabId = this.tabIdByGuestWebContentsId.get(input.guestWebContentsId)
    if (!tabId) throw new RuntimeError('BROWSER_TAB_NOT_FOUND')
    return this.takeRunControl({
      tabId,
      hostWebContentsId: input.hostWebContentsId,
      runId: input.runId
    })
  }

  takeRunControl(input: {
    tabId: string
    hostWebContentsId: number
    runId: string
  }): BrowserTabOwnership {
    const tab = this.tabsById.get(input.tabId)
    if (!tab || tab.hostWebContentsId !== input.hostWebContentsId)
      throw new RuntimeError('BROWSER_TAB_NOT_FOUND')
    requireText(input.runId, 'run_id')
    return this.ownership.takeControl({
      tabId: input.tabId,
      workspaceId: tab.ownership.workspaceId,
      controller: { kind: 'run', runId: input.runId }
    }).tab
  }

  takeUserControl(input: { tabId: string; hostWebContentsId: number }): BrowserTabOwnership {
    const tab = this.tabsById.get(input.tabId)
    if (!tab || tab.hostWebContentsId !== input.hostWebContentsId)
      throw new RuntimeError('BROWSER_TAB_NOT_FOUND')
    const host = webContents.fromId(input.hostWebContentsId)
    const ownerWindow = host ? BrowserWindow.fromWebContents(host) : null
    if (!ownerWindow || ownerWindow.isDestroyed())
      throw new RuntimeError('BROWSER_HOST_UNAVAILABLE')
    return this.ownership.takeControl({
      tabId: input.tabId,
      workspaceId: tab.ownership.workspaceId,
      controller: { kind: 'user', windowId: String(ownerWindow.id) }
    }).tab
  }

  async captureRegisteredGuest(input: {
    hostWebContentsId: number
    guestWebContentsId: number
    runId?: string
  }): Promise<BrowserScreenshot> {
    const tabId = this.tabIdByGuestWebContentsId.get(input.guestWebContentsId)
    const tab = tabId ? this.tabsById.get(tabId) : undefined
    if (!tab || tab.hostWebContentsId !== input.hostWebContentsId)
      throw new RuntimeError('BROWSER_TAB_NOT_FOUND')
    if (input.runId) this.requireRunControl(tab, input.runId)
    const guest = webContents.fromId(tab.guestWebContentsId)
    if (!guest || guest.isDestroyed() || guest.getType() !== 'webview')
      throw new RuntimeError('BROWSER_GUEST_UNAVAILABLE')
    const image = await guest.capturePage()
    if (image.isEmpty()) throw new RuntimeError('BROWSER_CAPTURE_FAILED')
    const png = image.toPNG()
    if (png.byteLength > 8 * 1024 * 1024) throw new RuntimeError('BROWSER_CAPTURE_TOO_LARGE')
    const { width, height } = image.getSize()
    return { data: png.toString('base64'), mediaType: 'image/png', width, height }
  }

  async executeRegisteredGuestScript(input: {
    hostWebContentsId: number
    guestWebContentsId: number
    runId?: string
    script: string
  }): Promise<unknown> {
    if (
      typeof input.script !== 'string' ||
      !input.script.trim() ||
      input.script.length > 256 * 1024
    )
      throw new RuntimeError('BROWSER_SCRIPT_INVALID')
    const tabId = this.tabIdByGuestWebContentsId.get(input.guestWebContentsId)
    const tab = tabId ? this.tabsById.get(tabId) : undefined
    if (!tab || tab.hostWebContentsId !== input.hostWebContentsId)
      throw new RuntimeError('BROWSER_TAB_NOT_FOUND')
    if (input.runId) this.requireRunControl(tab, input.runId)
    const guest = webContents.fromId(tab.guestWebContentsId)
    if (!guest || guest.isDestroyed() || guest.getType() !== 'webview')
      throw new RuntimeError('BROWSER_GUEST_UNAVAILABLE')
    return guest.executeJavaScript(input.script, true)
  }

  async navigateRegisteredGuest(input: {
    hostWebContentsId: number
    guestWebContentsId: number
    runId?: string
    action: BrowserNavigationAction
    url?: string
  }): Promise<BrowserNavigationState> {
    const tabId = this.tabIdByGuestWebContentsId.get(input.guestWebContentsId)
    if (!tabId) throw new RuntimeError('BROWSER_TAB_NOT_FOUND')
    return this.navigateUserTab({
      tabId,
      hostWebContentsId: input.hostWebContentsId,
      runId: input.runId,
      action: input.action,
      ...(input.url === undefined ? {} : { url: input.url })
    })
  }

  async navigateUserTab(input: {
    tabId: string
    hostWebContentsId: number
    runId?: string
    action: BrowserNavigationAction
    url?: string
  }): Promise<BrowserNavigationState> {
    const tab = this.tabsById.get(input.tabId)
    if (!tab || tab.hostWebContentsId !== input.hostWebContentsId)
      throw new RuntimeError('BROWSER_TAB_NOT_FOUND')
    if (input.runId) this.requireRunControl(tab, input.runId)
    const guest = webContents.fromId(tab.guestWebContentsId)
    if (!guest || guest.isDestroyed() || guest.getType() !== 'webview')
      throw new RuntimeError('BROWSER_GUEST_UNAVAILABLE')
    if (input.action === 'goto') {
      const url = safeBrowserUrl(input.url)
      if (!url) throw new RuntimeError('BROWSER_URL_INVALID')
      if (input.runId) {
        const decision = await checkBrowserUrlAccess(url, tab.projectId)
        if (!decision.allowed) throw new RuntimeError(decision.reason ?? 'BROWSER_ACCESS_DENIED')
        this.navigationPermits.add(`${tab.ownership.tabId}\n${url}`)
      }
      await guest.loadURL(url)
    } else if (input.action === 'back') {
      if (!guest.canGoBack()) throw new RuntimeError('BROWSER_CANNOT_GO_BACK')
      guest.goBack()
    } else if (input.action === 'forward') {
      if (!guest.canGoForward()) throw new RuntimeError('BROWSER_CANNOT_GO_FORWARD')
      guest.goForward()
    } else if (input.action === 'reload') {
      guest.reload()
    } else {
      guest.stop()
    }
    return browserNavigationState(guest)
  }

  unregisterUserTab(input: { tabId: string; hostWebContentsId: number }): boolean {
    const tab = this.tabsById.get(input.tabId)
    if (!tab || tab.hostWebContentsId !== input.hostWebContentsId) return false
    this.remove(input.tabId)
    return true
  }

  getRegisteredGuest(input: {
    hostWebContentsId: number
    guestWebContentsId: number
  }): RegisteredBrowserTab | null {
    const tabId = this.tabIdByGuestWebContentsId.get(input.guestWebContentsId)
    if (!tabId) return null
    const tab = this.tabsById.get(tabId)
    if (!tab || tab.hostWebContentsId !== input.hostWebContentsId) return null
    return { ...tab, ownership: { ...tab.ownership } }
  }

  findUserTab(input: {
    workspaceId: string
    sessionId: string
    projectId?: string
  }): RegisteredBrowserTab {
    const matches = [...this.tabsById.values()].filter(
      (tab) =>
        tab.ownership.workspaceId === input.workspaceId &&
        tab.sessionId === input.sessionId &&
        (input.projectId === undefined || tab.projectId === input.projectId)
    )
    if (matches.length !== 1) {
      throw new RuntimeError(matches.length ? 'BROWSER_TAB_AMBIGUOUS' : 'BROWSER_TAB_NOT_FOUND')
    }
    const tab = matches[0]
    return { ...tab, ownership: { ...tab.ownership } }
  }

  private requireRunControl(tab: RegisteredBrowserTab, runId: string): void {
    requireText(runId, 'run_id')
    const controller = this.ownership.get(tab.ownership.tabId)?.controller
    if (controller?.kind !== 'run' || controller.runId !== runId)
      throw new RuntimeError('BROWSER_RUN_CONTROL_REQUIRED')
  }

  private remove(tabId: string): void {
    const tab = this.tabsById.get(tabId)
    if (!tab) return
    this.tabsById.delete(tabId)
    this.tabIdByGuestWebContentsId.delete(tab.guestWebContentsId)
    this.ownership.remove(tabId)
  }

  private removeHostTabs(hostWebContentsId: number): void {
    for (const [tabId, tab] of this.tabsById) {
      if (tab.hostWebContentsId === hostWebContentsId) this.remove(tabId)
    }
  }
}

const browserService = new MainBrowserService()

export function registerBrowserUserTab(input: BrowserUserTabRegistration): BrowserTabOwnership {
  return browserService.registerUserTab(input)
}

export function takeRegisteredBrowserGuestRunControl(input: {
  hostWebContentsId: number
  guestWebContentsId: number
  runId: string
}): BrowserTabOwnership {
  return browserService.takeRegisteredGuestRunControl(input)
}

export function takeBrowserRunControl(input: {
  tabId: string
  hostWebContentsId: number
  runId: string
}): BrowserTabOwnership {
  return browserService.takeRunControl(input)
}

export function captureRegisteredBrowserGuest(input: {
  hostWebContentsId: number
  guestWebContentsId: number
  runId?: string
}): Promise<BrowserScreenshot> {
  return browserService.captureRegisteredGuest(input)
}

export function executeRegisteredBrowserGuestScript(input: {
  hostWebContentsId: number
  guestWebContentsId: number
  runId?: string
  script: string
}): Promise<unknown> {
  return browserService.executeRegisteredGuestScript(input)
}

export function navigateRegisteredBrowserGuest(input: {
  hostWebContentsId: number
  guestWebContentsId: number
  runId?: string
  action: BrowserNavigationAction
  url?: string
}): Promise<BrowserNavigationState> {
  return browserService.navigateRegisteredGuest(input)
}

export function navigateBrowserUserTab(input: {
  tabId: string
  hostWebContentsId: number
  action: BrowserNavigationAction
  url?: string
}): Promise<BrowserNavigationState> {
  return browserService.navigateUserTab(input)
}

export function takeBrowserUserControl(input: {
  tabId: string
  hostWebContentsId: number
}): BrowserTabOwnership {
  return browserService.takeUserControl(input)
}

export function unregisterBrowserUserTab(input: {
  tabId: string
  hostWebContentsId: number
}): boolean {
  return browserService.unregisterUserTab(input)
}

export function getRegisteredBrowserGuest(input: {
  hostWebContentsId: number
  guestWebContentsId: number
}): RegisteredBrowserTab | null {
  return browserService.getRegisteredGuest(input)
}

export function findBrowserUserTab(input: {
  workspaceId: string
  sessionId: string
  projectId?: string
}): RegisteredBrowserTab {
  return browserService.findUserTab(input)
}
