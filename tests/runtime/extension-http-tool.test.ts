import { describe, expect, it, vi } from 'vitest'
import type { ExtensionManifest } from '../../src/shared/extension-types'
import {
  executeExtensionHttpTool,
  interpolateExtensionValue,
  isExtensionNetworkAllowed
} from '../../src/main/extensions/extension-http-tool'

const manifest: ExtensionManifest = {
  schemaVersion: 1,
  id: 'example',
  name: 'Example',
  version: '1',
  permissions: { network: ['https://api.example.com/v1/*'] },
  tools: [
    {
      name: 'lookup',
      description: 'Lookup',
      inputSchema: { type: 'object' },
      kind: 'http',
      http: {
        method: 'POST',
        url: 'https://api.example.com/v1/items/{{input.id}}',
        headers: { Authorization: 'Bearer {{config.token}}' },
        body: { filter: '{{input.filter.name}}' }
      }
    }
  ]
}

describe('extension HTTP tools', () => {
  it('interpolates nested values while retaining JSON values in templates', () => {
    expect(
      interpolateExtensionValue('id={{input.id}}, key={{config.key}}', { id: 3 }, { key: 'x' })
    ).toBe('id=3, key=x')
    expect(interpolateExtensionValue({ value: '{{input.missing}}' }, {}, {})).toEqual({ value: '' })
  })

  it('requires a scheme, host, port and permitted path for every request', () => {
    expect(isExtensionNetworkAllowed(manifest, 'https://api.example.com/v1/items/1')).toBe(true)
    expect(isExtensionNetworkAllowed(manifest, 'https://api.example.com/v2/items/1')).toBe(false)
    expect(isExtensionNetworkAllowed(manifest, 'https://evil.example.com/v1/items/1')).toBe(false)
    expect(isExtensionNetworkAllowed(manifest, 'file:///tmp/x')).toBe(false)
  })

  it('honours the scheme declared in hostPermissions instead of requiring https', () => {
    const plain: ExtensionManifest = {
      ...manifest,
      permissions: {
        network: ['http://plain.example.com/v1/*'],
        hostPermissions: ['http://plain.example.com/v1/*']
      }
    }
    // A plain-http declaration must not reject every target.
    expect(isExtensionNetworkAllowed(plain, 'http://plain.example.com/v1/items')).toBe(true)
    // A declared scheme is exact: http does not smuggle in https.
    expect(isExtensionNetworkAllowed(plain, 'https://plain.example.com/v1/items')).toBe(false)
    // hostPermissions stays an upper bound over the runtime network allowlist.
    expect(isExtensionNetworkAllowed(plain, 'http://other.example.com/v1/items')).toBe(false)

    const anyScheme: ExtensionManifest = {
      ...manifest,
      permissions: {
        network: ['https://dual.example.com/v1/*', 'http://dual.example.com/v1/*'],
        hostPermissions: ['*://dual.example.com/v1/*']
      }
    }
    expect(isExtensionNetworkAllowed(anyScheme, 'https://dual.example.com/v1/items')).toBe(true)
    expect(isExtensionNetworkAllowed(anyScheme, 'http://dual.example.com/v1/items')).toBe(true)
  })

  it('lets a private host through only when both allowlists name it explicitly', () => {
    const loopback: ExtensionManifest = {
      ...manifest,
      permissions: {
        network: ['http://127.0.0.1:8080/api/*'],
        hostPermissions: ['http://127.0.0.1:8080/api/*']
      }
    }
    expect(isExtensionNetworkAllowed(loopback, 'http://127.0.0.1:8080/api/status')).toBe(true)
    const networkOnly: ExtensionManifest = {
      ...manifest,
      permissions: {
        network: ['http://127.0.0.1:8080/api/*'],
        hostPermissions: ['https://api.example.com/*']
      }
    }
    expect(isExtensionNetworkAllowed(networkOnly, 'http://127.0.0.1:8080/api/status')).toBe(false)
  })

  it('revalidates redirects and returns normalized tool data', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/1'))
        return new Response(null, { status: 302, headers: { location: '/v1/items/2' } })
      return new Response(JSON.stringify({ id: 2 }), { status: 200, statusText: 'OK' })
    })
    await expect(
      executeExtensionHttpTool({
        manifest,
        enabled: true,
        config: { token: 'secret' },
        toolName: 'lookup',
        input: { id: 1, filter: { name: 'open' } },
        fetch: fetcher
      })
    ).resolves.toMatchObject({
      __olaExtensionResult: true,
      text: 'HTTP 200 OK',
      data: { body: { id: 2 } }
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await expect(
      executeExtensionHttpTool({
        manifest,
        enabled: true,
        config: {},
        toolName: 'lookup',
        input: { id: '../../outside' },
        fetch: fetcher
      })
    ).rejects.toThrow('Network access denied')
  })

  it('extracts only declared credential-free HTTP links as artifacts', async () => {
    const linkManifest: ExtensionManifest = {
      ...manifest,
      tools: [
        {
          ...manifest.tools[0],
          artifact: { kind: 'link', urlPointer: '/report/url', titlePointer: '/report/name' }
        }
      ]
    }
    const result = await executeExtensionHttpTool({
      manifest: linkManifest,
      enabled: true,
      config: {},
      toolName: 'lookup',
      fetch: async () =>
        new Response(
          JSON.stringify({
            report: { url: 'https://reports.example.com/123', name: 'Quarterly report' }
          }),
          { status: 200 }
        )
    })
    expect(result.artifacts).toEqual([
      {
        kind: 'link',
        url: 'https://reports.example.com/123',
        title: 'Quarterly report'
      }
    ])
    const rejected = await executeExtensionHttpTool({
      manifest: linkManifest,
      enabled: true,
      config: {},
      toolName: 'lookup',
      fetch: async () =>
        new Response(JSON.stringify({ report: { url: 'javascript:alert(1)', name: 'unsafe' } }), {
          status: 200
        })
    })
    expect(rejected.artifacts).toEqual([])
    const failed = await executeExtensionHttpTool({
      manifest: linkManifest,
      enabled: true,
      config: {},
      toolName: 'lookup',
      fetch: async () =>
        new Response(JSON.stringify({ report: { url: 'https://reports.example.com/failed' } }), {
          status: 503,
          statusText: 'Unavailable'
        })
    })
    expect(failed.data).toMatchObject({ ok: false, status: 503 })
    expect(failed.artifacts).toEqual([])
  })

  it('rejects oversized extension responses before they enter runtime events', async () => {
    await expect(
      executeExtensionHttpTool({
        manifest,
        enabled: true,
        config: {},
        toolName: 'lookup',
        input: { id: 1 },
        fetch: async () =>
          new Response('ignored', {
            status: 200,
            headers: { 'content-length': String(128 * 1024 + 1) }
          })
      })
    ).rejects.toThrow('Extension response exceeds size limit')
  })
})
