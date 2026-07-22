import {
  getBrowserEmulationStatus,
  getBuiltInBrowserStorageSessions
} from '../browser/browser-emulation'
import { registerMessagePackHandler } from './messagepack-handler'
import { importBrowserCookies, listBrowserCookieProfiles } from '../browser/browser-cookie-import'

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function registerBrowserHandlers(): void {
  registerMessagePackHandler<undefined>('browser:cookie-profiles', async () => ({
    success: true,
    profiles: listBrowserCookieProfiles()
  }))

  registerMessagePackHandler<{ profileId: string; privacyConfirmed: boolean }>(
    'browser:import-cookies',
    async (input) => {
      if (!input?.privacyConfirmed) {
        return {
          success: false,
          imported: 0,
          skipped: 0,
          failed: 0,
          errorKind: 'privacy_confirmation_required'
        }
      }
      return importBrowserCookies(input.profileId)
    }
  )

  registerMessagePackHandler<undefined>('browser:clear-cookies', async () => {
    try {
      await Promise.all(
        getBuiltInBrowserStorageSessions().map((browserSession) =>
          browserSession.clearStorageData({ storages: ['cookies'] })
        )
      )
      return { success: true }
    } catch (error) {
      console.error('[Browser] Failed to clear cookies:', error)
      return { success: false, error: getErrorMessage(error) }
    }
  })

  registerMessagePackHandler<undefined>('browser:emulation-status', async () => {
    try {
      return { success: true, status: getBrowserEmulationStatus() }
    } catch (error) {
      console.error('[Browser] Failed to read browser emulation status:', error)
      return { success: false, error: getErrorMessage(error) }
    }
  })
}
