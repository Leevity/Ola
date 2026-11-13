import { describe, expect, it } from 'vitest'
import { resolveDroppedCapabilities } from '../../src/renderer/src/lib/run-capability-notice'
import {
  RUN_CAPABILITY_LABEL_KEYS,
  runCapabilityLabels
} from '../../src/renderer/src/lib/run-capability-labels'

describe('run capability notice', () => {
  it('reports switched-on capabilities even before they reach the tool snapshot', () => {
    expect(
      resolveDroppedCapabilities({
        advancedDrawEnabled: true,
        videoGenerationEnabled: true,
        snapshotToolNames: []
      })
    ).toEqual(['CanvasOperation', 'GenerateVideo'])
  })

  it('reports app-plugin capabilities and deduplicates snapshot entries', () => {
    const names = resolveDroppedCapabilities({
      codeGraphEnabled: true,
      desktopControlEnabled: true,
      snapshotToolNames: ['Read', 'GenerateVideo', 'DesktopClick', 'DesktopClick']
    })
    expect(names).toContain('codegraph_explore')
    expect(names).toContain('GenerateVideo')
    expect(names.filter((name) => name === 'DesktopClick')).toHaveLength(1)
    expect(names.filter((name) => name.startsWith('Desktop'))).toHaveLength(5)
  })

  it('returns nothing when no quarantined capability is enabled', () => {
    expect(
      resolveDroppedCapabilities({ snapshotToolNames: ['Read', 'Write', 'WebSearch'] })
    ).toEqual([])
  })

  it('never returns a name the transcript notice cannot label', () => {
    const names = resolveDroppedCapabilities({
      advancedDrawEnabled: true,
      videoGenerationEnabled: true,
      codeGraphEnabled: true,
      desktopControlEnabled: true,
      snapshotToolNames: ['unknown_future_tool']
    })
    expect(names.every((name) => RUN_CAPABILITY_LABEL_KEYS[name])).toBe(true)
    expect(runCapabilityLabels(names, (key) => key)).toEqual([
      'runCapability.canvas',
      'runCapability.video',
      'runCapability.codegraph',
      'runCapability.desktop'
    ])
  })
})
