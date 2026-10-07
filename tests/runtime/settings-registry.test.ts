import { describe, expect, it } from 'vitest'
import {
  SETTINGS_REGISTRY,
  SETTINGS_SECTIONS
} from '../../src/renderer/src/components/settings/settings-registry'

describe('settings navigation registry', () => {
  it('uses a distinct icon for each settings page', () => {
    const icons = SETTINGS_REGISTRY.map((page) => page.icon)
    expect(new Set(icons).size).toBe(icons.length)
  })

  it('keeps every settings section connected to at least one registered page', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(SETTINGS_REGISTRY.some((page) => page.section === section.id)).toBe(true)
    }
  })
})
