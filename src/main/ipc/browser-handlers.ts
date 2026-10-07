import { BrowserWindow, webContents, type IpcMainInvokeEvent } from 'electron'
import {
  getBrowserEmulationStatus,
  getBuiltInBrowserSession,
  getBuiltInBrowserStorageSessions
} from '../browser/browser-emulation'
import { registerMessagePackHandler } from './messagepack-handler'
import {
  exportBuiltInBrowserCookies,
  importBrowserCookies,
  listBrowserCookieProfiles
} from '../browser/browser-cookie-import'
import {
  captureRegisteredBrowserGuest,
  executeRegisteredBrowserGuestScript,
  getRegisteredBrowserGuest,
  navigateBrowserUserTab,
  navigateRegisteredBrowserGuest,
  registerBrowserUserTab,
  takeBrowserRunControl,
  takeRegisteredBrowserGuestRunControl,
  takeBrowserUserControl,
  unregisterBrowserUserTab
} from '../browser/browser-service'
import { WebContentsViewBrowserService } from '../browser/web-contents-view-service'
import { getSession } from '../db/sessions-dao'
import { getProject } from '../db/projects-dao'
import { loadManagedWorkspaceIds } from '../remote/account-client'
import { getRegisteredWindowWorkspace } from '../window-ipc'
import {
  browserPartitionForWorkspace,
  usesDefaultBrowserSession
} from '../../shared/browser-plugin'
import { checkBrowserUrlAccess } from '../browser/browser-access-policy'

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function isAuthorizedBrowserWorkspace(workspaceId: string): Promise<boolean> {
  if (workspaceId === 'local-personal') return true
  try {
    return (await loadManagedWorkspaceIds()).has(workspaceId)
  } catch {
    // Directory data is authorization metadata. A failed or offline refresh
    // must not make an old managed workspace implicitly writable.
    return false
  }
}

function isTrustedBrowserIpcSender(event: IpcMainInvokeEvent): boolean {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  return (
    ownerWindow !== null &&
    !ownerWindow.isDestroyed() &&
    ownerWindow.webContents === event.sender &&
    event.senderFrame === event.sender.mainFrame
  )
}

async function browserGuestAccessError(input: {
  hostWebContentsId: number
  guestWebContentsId: number
  url?: string
}): Promise<string | null> {
  const tab = getRegisteredBrowserGuest(input)
  if (!tab) return 'Browser tab is not registered to this window.'
  const guest = webContents.fromId(input.guestWebContentsId)
  if (!guest || guest.isDestroyed()) return 'Browser page is unavailable.'
  const url = input.url ?? guest.getURL()
  const decision = await checkBrowserUrlAccess(url, tab.projectId)
  return decision.allowed ? null : (decision.reason ?? 'Browser access denied.')
}

function registerTrustedBrowserMessagePackHandler<TArgs>(
  channel: string,
  handler: (args: TArgs, event: IpcMainInvokeEvent) => Promise<unknown> | unknown
): void {
  registerMessagePackHandler<TArgs>(channel, async (args, event) => {
    if (!isTrustedBrowserIpcSender(event)) {
      return { success: false, error: 'Unauthorized browser IPC sender' }
    }
    return await handler(args, event)
  })
}

const webContentsViewBrowserService = new WebContentsViewBrowserService()

webContentsViewBrowserService.onNavigationEvent((event) => {
  const host = webContents.fromId(event.hostWebContentsId)
  if (host && !host.isDestroyed()) host.send('browser:view-event', event)
})

export function registerBrowserHandlers(): void {
  registerTrustedBrowserMessagePackHandler<void>('browser:view-status', () => ({
    // WebContentsView is the production host now. Keep an explicit opt-out
    // for platforms or builds that still need the legacy <webview> fallback.
    enabled: process.env.OLA_BROWSER_USE_WEBCONTENTS_VIEW !== '0'
  }))

  registerTrustedBrowserMessagePackHandler<{
    tabId: string
    workspaceId: string
    profileId: string
    bounds: { x: number; y: number; width: number; height: number }
    partition?: string
    userAgent?: string
    url?: string
  }>('browser:view-create', async (input, event) => {
    try {
      if (
        !input ||
        typeof input.tabId !== 'string' ||
        typeof input.workspaceId !== 'string' ||
        typeof input.profileId !== 'string' ||
        !input.bounds ||
        ![input.bounds.x, input.bounds.y, input.bounds.width, input.bounds.height].every((value) =>
          Number.isFinite(value)
        ) ||
        input.bounds.width <= 0 ||
        input.bounds.height <= 0 ||
        (input.url !== undefined && typeof input.url !== 'string')
      ) {
        return { success: false, error: 'Invalid WebContentsView tab request' }
      }
      const ownerWindow = BrowserWindow.fromWebContents(event.sender)
      const senderWorkspaceId = ownerWindow ? getRegisteredWindowWorkspace(ownerWindow) : null
      if (!senderWorkspaceId || senderWorkspaceId !== input.workspaceId) {
        return { success: false, error: 'Browser workspace does not match its owner window' }
      }
      if (!(await isAuthorizedBrowserWorkspace(input.workspaceId))) {
        return { success: false, error: 'Unauthorized workspace' }
      }
      const browserMode = getBrowserEmulationStatus()
      const expectedPartition = usesDefaultBrowserSession(
        input.workspaceId,
        browserMode.reuseEnabled
      )
        ? undefined
        : browserPartitionForWorkspace(input.workspaceId)
      const expectedProfileId = expectedPartition ?? 'external-user-data'
      if (input.partition !== expectedPartition || input.profileId !== expectedProfileId) {
        return { success: false, error: 'Browser session does not match its workspace' }
      }
      const tab = webContentsViewBrowserService.createTab({
        tabId: input.tabId,
        workspaceId: input.workspaceId,
        profileId: input.profileId,
        hostWebContentsId: event.sender.id,
        bounds: input.bounds,
        ...(input.partition ? { partition: input.partition } : {}),
        ...(input.userAgent ? { userAgent: input.userAgent } : {})
      })
      const state = input.url
        ? await webContentsViewBrowserService.navigate(
            input.tabId,
            event.sender.id,
            'goto',
            input.url
          )
        : webContentsViewBrowserService.getNavigationState(input.tabId, event.sender.id)
      return { success: true, tabId: tab.tabId, state }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  })

  registerTrustedBrowserMessagePackHandler<{
    tabId: string
    bounds: { x: number; y: number; width: number; height: number }
  }>('browser:view-set-bounds', (input, event) => {
    try {
      if (!input?.tabId || !input.bounds || input.bounds.width <= 0 || input.bounds.height <= 0)
        return { success: false, error: 'Invalid WebContentsView bounds' }
      webContentsViewBrowserService.setBounds(input.tabId, event.sender.id, input.bounds)
      return { success: true }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  })

  registerTrustedBrowserMessagePackHandler<{
    tabId: string
    action: 'back' | 'forward' | 'reload' | 'stop' | 'goto'
    url?: string
  }>('browser:view-navigate', async (input, event) => {
    try {
      if (
        !input?.tabId ||
        !['back', 'forward', 'reload', 'stop', 'goto'].includes(input.action) ||
        (input.action === 'goto' && typeof input.url !== 'string')
      )
        return { success: false, error: 'Invalid WebContentsView navigation' }
      const state = await webContentsViewBrowserService.navigate(
        input.tabId,
        event.sender.id,
        input.action,
        input.url
      )
      return { success: true, state }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  })

  registerTrustedBrowserMessagePackHandler<{ tabId: string }>(
    'browser:view-destroy',
    (input, event) => {
      try {
        return {
          success: Boolean(
            input?.tabId && webContentsViewBrowserService.destroyTab(input.tabId, event.sender.id)
          )
        }
      } catch (error) {
        return { success: false, error: getErrorMessage(error) }
      }
    }
  )

  registerTrustedBrowserMessagePackHandler<{
    tabId: string
    workspaceId: string
    profileId: string
    guestWebContentsId: number
    sessionId?: string | null
    projectId?: string | null
  }>('browser:register-tab', async (input, event) => {
    try {
      if (
        !input ||
        typeof input.tabId !== 'string' ||
        typeof input.workspaceId !== 'string' ||
        typeof input.profileId !== 'string' ||
        !Number.isInteger(input.guestWebContentsId) ||
        (input.sessionId !== undefined &&
          input.sessionId !== null &&
          (typeof input.sessionId !== 'string' || !input.sessionId.trim())) ||
        (input.projectId !== undefined &&
          input.projectId !== null &&
          (typeof input.projectId !== 'string' || !input.projectId.trim()))
      ) {
        return { success: false, error: 'Invalid browser tab registration' }
      }
      const ownerWindow = BrowserWindow.fromWebContents(event.sender)
      const senderWorkspaceId = ownerWindow ? getRegisteredWindowWorkspace(ownerWindow) : null
      if (!senderWorkspaceId || senderWorkspaceId !== input.workspaceId) {
        return { success: false, error: 'Browser workspace does not match its owner window' }
      }
      if (!(await isAuthorizedBrowserWorkspace(input.workspaceId))) {
        return { success: false, error: 'Unauthorized workspace' }
      }
      const guest = webContents.fromId(input.guestWebContentsId)
      if (!guest || guest.session !== getBuiltInBrowserSession(input.workspaceId)) {
        return { success: false, error: 'Browser session does not match its workspace' }
      }
      if (input.sessionId) {
        const session = await getSession(input.sessionId, input.workspaceId)
        if (!session) return { success: false, error: 'Browser session workspace mismatch' }
        if (input.projectId && session.project_id !== input.projectId) {
          return { success: false, error: 'Browser project does not own the selected session' }
        }
      }
      if (input.projectId) {
        const project = await getProject(input.projectId, input.workspaceId)
        if (!project) return { success: false, error: 'Browser project workspace mismatch' }
      }
      registerBrowserUserTab({
        tabId: input.tabId,
        workspaceId: input.workspaceId,
        profileId: input.profileId,
        hostWebContentsId: event.sender.id,
        guestWebContentsId: input.guestWebContentsId,
        sessionId: input.sessionId,
        projectId: input.projectId
      })
      return { success: true }
    } catch (error) {
      console.warn('[Browser] Failed to register browser tab:', getErrorMessage(error))
      return { success: false, error: getErrorMessage(error) }
    }
  })

  registerTrustedBrowserMessagePackHandler<{ guestWebContentsId: number; runId?: string }>(
    'browser:capture-page',
    async (input, event) => {
      if (!input || !Number.isInteger(input.guestWebContentsId))
        return { success: false, error: 'Invalid browser capture request' }
      try {
        const accessError = await browserGuestAccessError({
          hostWebContentsId: event.sender.id,
          guestWebContentsId: input.guestWebContentsId
        })
        if (accessError) return { success: false, error: accessError }
        return {
          success: true,
          screenshot: await captureRegisteredBrowserGuest({
            hostWebContentsId: event.sender.id,
            guestWebContentsId: input.guestWebContentsId,
            runId: input.runId
          })
        }
      } catch (error) {
        return { success: false, error: getErrorMessage(error) }
      }
    }
  )

  registerTrustedBrowserMessagePackHandler<{
    guestWebContentsId: number
    runId?: string
    script: string
  }>('browser:execute-script', async (input, event) => {
    if (!input || !Number.isInteger(input.guestWebContentsId) || typeof input.script !== 'string')
      return { success: false, error: 'Invalid browser script request' }
    try {
      const accessError = await browserGuestAccessError({
        hostWebContentsId: event.sender.id,
        guestWebContentsId: input.guestWebContentsId
      })
      if (accessError) return { success: false, error: accessError }
      return {
        success: true,
        result: await executeRegisteredBrowserGuestScript({
          hostWebContentsId: event.sender.id,
          guestWebContentsId: input.guestWebContentsId,
          runId: input.runId,
          script: input.script
        })
      }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  })

  registerTrustedBrowserMessagePackHandler<{
    guestWebContentsId: number
    runId?: string
    action: 'back' | 'forward' | 'reload' | 'stop' | 'goto'
    url?: string
  }>('browser:navigate-guest', async (input, event) => {
    if (
      !input ||
      !Number.isInteger(input.guestWebContentsId) ||
      !['back', 'forward', 'reload', 'stop', 'goto'].includes(input.action) ||
      (input.url !== undefined && typeof input.url !== 'string') ||
      (input.action === 'goto' && typeof input.url !== 'string')
    )
      return { success: false, error: 'Invalid browser navigation request' }
    try {
      const accessError = await browserGuestAccessError({
        hostWebContentsId: event.sender.id,
        guestWebContentsId: input.guestWebContentsId,
        ...(input.action === 'goto' ? { url: input.url } : {})
      })
      if (accessError) return { success: false, error: accessError }
      return {
        success: true,
        state: await navigateRegisteredBrowserGuest({
          hostWebContentsId: event.sender.id,
          guestWebContentsId: input.guestWebContentsId,
          runId: input.runId,
          action: input.action,
          ...(input.url === undefined ? {} : { url: input.url })
        })
      }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  })

  registerTrustedBrowserMessagePackHandler<{
    tabId: string
    action: 'back' | 'forward' | 'reload' | 'stop' | 'goto'
    url?: string
  }>('browser:navigate', async (input, event) => {
    if (
      !input ||
      typeof input.tabId !== 'string' ||
      !['back', 'forward', 'reload', 'stop', 'goto'].includes(input.action) ||
      (input.url !== undefined && typeof input.url !== 'string') ||
      (input.action === 'goto' && typeof input.url !== 'string')
    )
      return { success: false, error: 'Invalid browser navigation request' }
    try {
      return {
        success: true,
        state: await navigateBrowserUserTab({
          tabId: input.tabId,
          hostWebContentsId: event.sender.id,
          action: input.action,
          ...(input.url === undefined ? {} : { url: input.url })
        })
      }
    } catch (error) {
      return { success: false, error: getErrorMessage(error) }
    }
  })

  registerTrustedBrowserMessagePackHandler<{ guestWebContentsId: number; runId: string }>(
    'browser:take-guest-run-control',
    (input, event) => {
      if (!input || !Number.isInteger(input.guestWebContentsId) || typeof input.runId !== 'string')
        return { success: false, error: 'Invalid browser run control request' }
      try {
        const tab = takeRegisteredBrowserGuestRunControl({
          hostWebContentsId: event.sender.id,
          guestWebContentsId: input.guestWebContentsId,
          runId: input.runId
        })
        return { success: true, controller: tab.controller }
      } catch (error) {
        return { success: false, error: getErrorMessage(error) }
      }
    }
  )

  registerTrustedBrowserMessagePackHandler<{ tabId: string; runId: string }>(
    'browser:take-run-control',
    (input, event) => {
      if (
        !input ||
        typeof input.tabId !== 'string' ||
        !input.tabId.trim() ||
        typeof input.runId !== 'string' ||
        !input.runId.trim()
      )
        return { success: false, error: 'Invalid browser run control request' }
      try {
        const tab = takeBrowserRunControl({
          tabId: input.tabId,
          hostWebContentsId: event.sender.id,
          runId: input.runId
        })
        return { success: true, controller: tab.controller }
      } catch (error) {
        return { success: false, error: getErrorMessage(error) }
      }
    }
  )

  registerTrustedBrowserMessagePackHandler<{ tabId: string }>(
    'browser:take-control',
    (input, event) => {
      if (!input || typeof input.tabId !== 'string' || !input.tabId.trim())
        return { success: false, error: 'Invalid browser tab control request' }
      try {
        const tab = takeBrowserUserControl({
          tabId: input.tabId,
          hostWebContentsId: event.sender.id
        })
        return { success: true, controller: tab.controller }
      } catch (error) {
        return { success: false, error: getErrorMessage(error) }
      }
    }
  )

  registerTrustedBrowserMessagePackHandler<{ tabId: string }>(
    'browser:unregister-tab',
    async (input, event) => {
      if (!input || typeof input.tabId !== 'string') {
        return { success: false, error: 'Invalid browser tab unregistration' }
      }
      return {
        success: unregisterBrowserUserTab({
          tabId: input.tabId,
          hostWebContentsId: event.sender.id
        })
      }
    }
  )

  registerTrustedBrowserMessagePackHandler<undefined>('browser:cookie-profiles', async () => ({
    success: true,
    profiles: listBrowserCookieProfiles()
  }))

  registerTrustedBrowserMessagePackHandler<{ workspaceId: string }>(
    'browser:export-cookies',
    async (input, event) => {
      if (
        typeof input?.workspaceId !== 'string' ||
        !input.workspaceId.trim() ||
        !(await isAuthorizedBrowserWorkspace(input.workspaceId))
      ) {
        return { success: false, exported: 0, error: 'Unauthorized workspace' }
      }
      return await exportBuiltInBrowserCookies(event.sender, input.workspaceId)
    }
  )

  registerTrustedBrowserMessagePackHandler<{
    profileId: string
    workspaceId: string
    privacyConfirmed: boolean
  }>('browser:import-cookies', async (input) => {
    if (!input?.privacyConfirmed) {
      return {
        success: false,
        imported: 0,
        skipped: 0,
        failed: 0,
        errorKind: 'privacy_confirmation_required'
      }
    }
    if (
      typeof input.workspaceId !== 'string' ||
      !input.workspaceId.trim() ||
      !(await isAuthorizedBrowserWorkspace(input.workspaceId))
    ) {
      return { success: false, imported: 0, skipped: 0, failed: 0, error: 'Unauthorized workspace' }
    }
    return importBrowserCookies(input.profileId, input.workspaceId)
  })

  registerTrustedBrowserMessagePackHandler<{ workspaceId: string }>(
    'browser:clear-cookies',
    async (input) => {
      try {
        if (
          typeof input?.workspaceId !== 'string' ||
          !input.workspaceId.trim() ||
          !(await isAuthorizedBrowserWorkspace(input.workspaceId))
        ) {
          return { success: false, error: 'Unauthorized workspace' }
        }
        await Promise.all(
          getBuiltInBrowserStorageSessions([input.workspaceId]).map((browserSession) =>
            browserSession.clearStorageData({ storages: ['cookies'] })
          )
        )
        return { success: true }
      } catch (error) {
        console.error('[Browser] Failed to clear cookies:', error)
        return { success: false, error: getErrorMessage(error) }
      }
    }
  )

  registerTrustedBrowserMessagePackHandler<undefined>('browser:emulation-status', async () => {
    try {
      return { success: true, status: getBrowserEmulationStatus() }
    } catch (error) {
      console.error('[Browser] Failed to read browser emulation status:', error)
      return { success: false, error: getErrorMessage(error) }
    }
  })
}
