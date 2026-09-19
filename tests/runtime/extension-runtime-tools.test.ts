import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeExtension } from '../../src/main/extensions/extension-service'
import {
  createExtensionRuntimeTools,
  extensionRuntimeToolName
} from '../../src/main/extensions/extension-runtime-tools'

afterEach(() => {
  vi.unstubAllGlobals()
})

const extension: RuntimeExtension = {
  id: 'weather',
  enabled: true,
  config: { token: 'secret-token' },
  manifest: {
    schemaVersion: 1,
    id: 'weather',
    name: 'Weather',
    version: '1',
    permissions: { network: ['https://api.example.test/v1/*'] },
    tools: [
      {
        name: 'lookup',
        description: 'Lookup weather',
        kind: 'http',
        readOnly: true,
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false
        },
        http: {
          method: 'GET',
          url: 'https://api.example.test/v1/weather/{{input.city}}',
          headers: { Authorization: 'Bearer {{config.token}}' }
        }
      },
      {
        name: 'quarantined_js',
        description: 'Quarantined',
        kind: 'js',
        inputSchema: { type: 'object' },
        handler: 'run'
      }
    ]
  }
}

describe('extension runtime tools', () => {
  it('exposes only explicitly selected enabled HTTP extensions without leaking config', async () => {
    const getRuntime = vi.fn(async (id: string) => (id === 'weather' ? extension : null))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret-token' })
        return new Response(JSON.stringify({ city: 'Hangzhou' }), {
          status: 200,
          headers: { 'set-cookie': 'secret-cookie', 'x-request-id': 'safe' }
        })
      })
    )
    const tools = await createExtensionRuntimeTools({ getRuntime } as never, ['weather', 'missing'])
    expect(getRuntime).toHaveBeenCalledTimes(2)
    expect(tools.map((tool) => tool.name)).toEqual([extensionRuntimeToolName('weather', 'lookup')])
    expect(tools[0]?.effect).toBe('read')
    const input = tools[0]!.validate({ city: 'Hangzhou' })
    await expect(
      tools[0]!.execute(input, { signal: new AbortController().signal } as never)
    ).resolves.toMatchObject({
      extensionId: 'weather',
      toolName: 'lookup',
      data: { headers: { 'x-request-id': 'safe' }, body: { city: 'Hangzhou' } }
    })
    const result = await tools[0]!.execute(input, { signal: new AbortController().signal } as never)
    expect(JSON.stringify(result)).not.toContain('secret-token')
    expect(JSON.stringify(result)).not.toContain('secret-cookie')
  })

  it('does not expose disabled extensions and validates the declared object boundary', async () => {
    const disabled: RuntimeExtension = { ...extension, enabled: false }
    await expect(
      createExtensionRuntimeTools({ getRuntime: async () => disabled } as never, ['weather'])
    ).resolves.toEqual([])
    const tools = await createExtensionRuntimeTools(
      { getRuntime: async () => extension } as never,
      ['weather']
    )
    expect(() => tools[0]!.validate({})).toThrow('INVALID_TOOL_INPUT')
    expect(() => tools[0]!.validate({ city: 'Hangzhou', extra: true })).toThrow(
      'INVALID_TOOL_INPUT'
    )
  })
})
