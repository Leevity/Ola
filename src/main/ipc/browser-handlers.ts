import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  getBrowserEmulationStatus,
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
  navigateBrowserUserTab,
  navigateRegisteredBrowserGuest,
  registerBrowserUserTab,
  takeBrowserRunControl,
  takeRegisteredBrowserGuestRunControl,
  takeBrowserUserControl,
  unregisterBrowserUserTab
} from '../browser/browser-service'
import { getSession } from '../db/sessions-dao'
import { getProject } from '../db/projects-dao'
import { loadManagedWorkspaceIds } from '../remote/account-client'

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

export function registerBrowserHandlers(): void {
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
          typeof input.sessionId !== 'string') ||
        (input.projectId !== undefined &&
          input.projectId !== null &&
          typeof input.projectId !== 'string')
      ) {
        return { success: false, error: 'Invalid browser tab registration' }
      }
      if (input.sessionId) {
        const session = await getSession(input.sessionId, input.workspaceId)
        if (!session) return { success: false, error: 'Browser session workspace mismatch' }
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
        guestWebContentsId: input.guestWebContentsId
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
