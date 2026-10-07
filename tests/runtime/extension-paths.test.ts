import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import {
  extensionManifestPath,
  normalizeExtensionId,
  resolveExtensionAssetPath,
  resolveExtensionPath
} from '../../src/main/extensions/extension-paths'

describe('extension paths', () => {
  it('normalizes valid ids and confines extension paths', () => {
    expect(normalizeExtensionId(' Example_Extension ')).toBe('example_extension')
    const extensionDirectory = resolve('/tmp/extensions/sample')
    expect(resolveExtensionPath('/tmp/extensions', 'sample')).toBe(extensionDirectory)
    expect(extensionManifestPath('/tmp/extensions', 'sample')).toBe(
      join(extensionDirectory, 'extension.json')
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
