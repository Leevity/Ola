import { describe, expect, it } from 'vitest'
import { normalizeThemePreferences } from '../../src/renderer/src/lib/theme-preferences'

describe('theme preference preservation', () => {
  it('uses system appearance and the connected brand for missing preferences', () => {
    expect(normalizeThemePreferences({})).toEqual({
      theme: 'system',
      themePreset: 'connected',
      sshTerminalThemePreset: 'connected'
    })
  })
  it.each(['studio', 'mulberry', 'graphite', 'ocean', 'forest', 'dawn', 'connected'])(
    'retains saved %s choices rather than inferring whether they were defaults',
    (preset) => {
      for (const theme of ['light', 'dark', 'system']) {
        expect(
          normalizeThemePreferences({ theme, themePreset: preset, sshTerminalThemePreset: preset })
        ).toEqual({ theme, themePreset: preset, sshTerminalThemePreset: preset })
      }
    }
  )
  it('keeps different application and terminal presets independently', () => {
    expect(
      normalizeThemePreferences({
        theme: 'dark',
        themePreset: 'studio',
        sshTerminalThemePreset: 'graphite'
      })
    ).toEqual({ theme: 'dark', themePreset: 'studio', sshTerminalThemePreset: 'graphite' })
  })
  it('replaces invalid values without retaining inherited object keys', () => {
    expect(
      normalizeThemePreferences({
        theme: 'invalid',
        themePreset: '__proto__',
        sshTerminalThemePreset: null
      })
    ).toEqual({ theme: 'system', themePreset: 'connected', sshTerminalThemePreset: 'connected' })
  })
})
