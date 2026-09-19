import { describe, expect, it } from 'vitest'
import {
  extensionManifestPath,
  normalizeExtensionId,
  resolveExtensionAssetPath,
  resolveExtensionPath
} from '../../src/main/extensions/extension-paths'

describe('extension paths', () => {
  it('normalizes valid ids and confines extension paths', () => {
    expect(normalizeExtensionId(' Example_Extension ')).toBe('example_extension')
    expect(resolveExtensionPath('/tmp/extensions', 'sample')).toBe('/tmp/extensions/sample')
    expect(extensionManifestPath('/tmp/extensions', 'sample')).toBe(
      '/tmp/extensions/sample/extension.json'
    )
  })

  it('rejects invalid ids and asset traversal', () => {
    for (const value of ['', 'a', '../escape', 'bad/id', 'UPPER space'])
      expect(() => normalizeExtensionId(value)).toThrow('Invalid extension id')
    expect(() => resolveExtensionAssetPath('/tmp/extensions', 'sample', '../secret')).toThrow(
      'Asset path escapes extension'
    )
  })
})
