import { describe, expect, it, vi } from 'vitest'

const config = vi.hoisted(() => ({ value: undefined as unknown }))
vi.mock('../../src/main/ipc/secure-key-store', () => ({
  getConfigValue: vi.fn(async () => config.value)
}))

import {
  checkBrowserUrlAccess,
  resolveBrowserPolicy
} from '../../src/main/browser/browser-access-policy'

describe('Main Browser domain policy', () => {
  it('applies the global browser policy and project overrides', async () => {
    config.value = {
      state: {
        pluginsByProject: {
          __global__: [
            {
              id: 'browser',
              enabled: true,
              browserAllowedDomains: ['*.example.com'],
              browserBlockedDomains: ['private.example.com']
            }
          ],
          project: [
            {
              id: 'browser',
              enabled: true,
              browserAllowedDomains: ['docs.example.org'],
              browserBlockedDomains: []
            }
          ]
        }
      },
      version: 5
    }
    expect(await checkBrowserUrlAccess('https://www.example.com/path')).toEqual({ allowed: true })
    expect(await checkBrowserUrlAccess('https://private.example.com')).toMatchObject({
      allowed: false
    })
    expect(await checkBrowserUrlAccess('https://docs.example.org', 'project')).toEqual({
      allowed: true
    })
    expect(await checkBrowserUrlAccess('https://www.example.com', 'project')).toEqual({
      allowed: false,
      reason: 'BROWSER_DOMAIN_NOT_ALLOWED'
    })
  })

  it('fails closed for disabled Browser and unsupported URL protocols', async () => {
    config.value = {
      state: { pluginsByProject: { __global__: [{ id: 'browser', enabled: false }] } },
      version: 5
    }
    expect(await checkBrowserUrlAccess('https://example.com')).toEqual({
      allowed: false,
      reason: 'BROWSER_PLUGIN_DISABLED'
    })
    expect(await checkBrowserUrlAccess('file:///C:/secret.txt')).toEqual({
      allowed: false,
      reason: 'BROWSER_URL_INVALID'
    })
    expect(await resolveBrowserPolicy()).toMatchObject({ enabled: false })
  })
})
