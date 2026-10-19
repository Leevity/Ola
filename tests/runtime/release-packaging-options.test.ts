import { describe, expect, it } from 'vitest'
import { nativeDmgArguments } from '../../scripts/native-unsigned-dmg.mjs'
import {
  releaseBuilderEnvironment,
  releaseTargets
} from '../../scripts/release-packaging-options.mjs'

describe('release packaging compatibility', () => {
  it('builds unsigned Mac ZIP before creating the verified native DMG', () => {
    expect(releaseTargets('mac', false, true)).toEqual(['zip'])
    expect(releaseTargets('mac', false, false)).toEqual(['dmg', 'zip'])
    expect(releaseTargets('mac', true, true)).toEqual(['--dir'])
  })
  it('retains Windows and Linux installer targets', () => {
    expect(releaseTargets('win', false, true)).toEqual(['nsis', 'zip'])
    expect(releaseTargets('linux', false, true)).toEqual(['AppImage', 'deb'])
  })
  it('pins the compatible NSIS filter only for Windows ARM64', () => {
    const original = { EXAMPLE: 'retained', ELECTRON_BUILDER_7Z_FILTER: 'BCJ2' }
    expect(releaseBuilderEnvironment('win', 'arm64', original)).toMatchObject({
      ELECTRON_BUILDER_7Z_FILTER: 'BCJ',
      EXAMPLE: 'retained',
      NODE_OPTIONS: '--max-old-space-size=4096'
    })
    expect(releaseBuilderEnvironment('win', 'x64', original).ELECTRON_BUILDER_7Z_FILTER).toBe(
      'BCJ2'
    )
    expect(original.ELECTRON_BUILDER_7Z_FILTER).toBe('BCJ2')
    expect(releaseBuilderEnvironment('mac', 'arm64', {}).ELECTRON_BUILDER_7Z_FILTER).toBeUndefined()
  })
  it('creates a compressed read-only image from the dedicated content directory', () => {
    expect(nativeDmgArguments('/tmp/ola-content', '/tmp/ola-1.0.6.dmg', 'Ola 1.0.6')).toEqual([
      'create',
      '-ov',
      '-fs',
      'HFS+',
      '-format',
      'UDZO',
      '-volname',
      'Ola 1.0.6',
      '-srcfolder',
      '/tmp/ola-content',
      '/tmp/ola-1.0.6.dmg'
    ])
  })
  it.each(['/tmp/ola-content/inside.dmg', '/tmp/ola-content/..hidden.dmg', '/tmp/not-a-dmg.zip'])(
    'rejects unsafe or invalid DMG output %s',
    (output) => {
      expect(() => nativeDmgArguments('/tmp/ola-content', output, 'Ola')).toThrow('DMG output')
    }
  )
  it('rejects relative paths and invalid volume labels', () => {
    expect(() => nativeDmgArguments('content', '/tmp/output.dmg', 'Ola')).toThrow('absolute')
    expect(() => nativeDmgArguments('/tmp/content', '/tmp/output.dmg', 'Ola\nInjected')).toThrow(
      'volume name'
    )
  })
})
