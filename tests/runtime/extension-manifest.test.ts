import { describe, expect, it } from 'vitest'
import { parseExtensionManifest } from '../../src/main/extensions/extension-manifest'

describe('extension manifests', () => {
  it('normalizes an HTTP extension and preserves safe optional UI metadata', () => {
    expect(
      parseExtensionManifest({
        schemaVersion: 1,
        id: ' Example ',
        name: ' Example ',
        version: ' 1.0.0 ',
        configSchema: [{ key: 'token', type: 'secret' }],
        permissions: { network: [' https://example.com ', ''] },
        tools: [{ name: 'weather', kind: 'http', http: { url: ' https://example.com/weather ' } }],
        renderers: [{ name: 'result', entry: 'result.html' }]
      })
    ).toEqual({
      schemaVersion: 1,
      id: 'example',
      name: 'Example',
      version: '1.0.0',
      configSchema: [{ key: 'token', label: 'token', type: 'secret' }],
      permissions: { network: ['https://example.com'] },
      tools: [
        {
          name: 'weather',
          description: 'weather',
          inputSchema: { type: 'object' },
          kind: 'http',
          http: { method: 'GET', url: 'https://example.com/weather' }
        }
      ],
      renderers: [{ name: 'result', type: 'html', entry: 'result.html' }]
    })
  })

  it('rejects manifest ids, duplicate definitions, and incomplete tools', () => {
    const base = { schemaVersion: 1, id: 'example', name: 'Example', version: '1', tools: [] }
    expect(() => parseExtensionManifest(base)).toThrow('at least one supported tool')
    expect(() =>
      parseExtensionManifest({ ...base, tools: [{ name: '1bad', kind: 'js', handler: 'run' }] })
    ).toThrow('invalid extension tool name')
    expect(() =>
      parseExtensionManifest({ ...base, tools: [{ name: 'run', kind: 'js', handler: 'run' }] })
    ).toThrow('extension entry is required')
    expect(() =>
      parseExtensionManifest({
        ...base,
        tools: [
          { name: 'run', kind: 'http', http: { url: 'https://example.com' } },
          { name: 'run', kind: 'http', http: { url: 'https://example.com' } }
        ]
      })
    ).toThrow('duplicate tool name')
  })
})
