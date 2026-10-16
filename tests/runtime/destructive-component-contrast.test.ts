import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Button } from '../../src/renderer/src/components/ui/button'
import { Badge } from '../../src/renderer/src/components/ui/badge'
import { getThemePresetDefinition } from '../../src/renderer/src/lib/theme-presets'

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/../g)!
    .map((value) => parseInt(value, 16) / 255)
  const linear = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  )
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

describe('destructive component foreground', () => {
  it('uses the theme foreground without a dark translucent background', () => {
    for (const Component of [Button, Badge]) {
      const html = renderToStaticMarkup(
        createElement(Component, { variant: 'destructive' }, 'Revoke')
      )
      expect(html).toContain('text-destructive-foreground')
      expect(html).not.toContain('text-white')
      expect(html).not.toContain('dark:bg-destructive/60')
    }
  })

  it.each(['light', 'dark'] as const)(
    'meets normal-text contrast in the connected %s theme',
    (mode) => {
      const colors = getThemePresetDefinition('connected').cssVars[mode]
      const levels = [
        luminance(colors['--destructive']),
        luminance(colors['--destructive-foreground'])
      ].sort((a, b) => a - b)
      expect((levels[1] + 0.05) / (levels[0] + 0.05)).toBeGreaterThanOrEqual(4.5)
    }
  )
})
