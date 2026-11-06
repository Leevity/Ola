import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ value: null as unknown }))

vi.mock('../../src/main/ipc/secure-key-store', () => ({
  getConfigValue: async () => store.value
}))

import {
  DESKTOP_ACCESSIBILITY_PLUGIN_ID,
  normalizeAllowedApps,
  resolveDesktopAxAllowedApps
} from '../../src/main/agent-desktop/allowed-apps'

/** The shape zustand's persist middleware writes under `config:get('ola-app-plugins')`. */
function persisted(entries: Record<string, unknown[]>): unknown {
  return { state: { pluginsByProject: entries } }
}

function plugin(apps?: unknown): Record<string, unknown> {
  return { id: DESKTOP_ACCESSIBILITY_PLUGIN_ID, enabled: true, desktopAllowedApps: apps }
}

beforeEach(() => {
  store.value = null
})

describe('desktop accessibility application bound', () => {
  it('reads the global plugin entry', async () => {
    store.value = persisted({ __global__: [plugin(['TextEdit', 'Notes'])] })
    expect(await resolveDesktopAxAllowedApps(null)).toEqual(['TextEdit', 'Notes'])
  })

  it('lets the project override replace the global list', async () => {
    store.value = persisted({
      __global__: [plugin(['TextEdit'])],
      'project-a': [plugin(['Notes'])]
    })
    expect(await resolveDesktopAxAllowedApps('project-a')).toEqual(['Notes'])
    expect(await resolveDesktopAxAllowedApps(null)).toEqual(['TextEdit'])
  })

  it('returns nothing until a configuration exists', async () => {
    expect(await resolveDesktopAxAllowedApps(null)).toEqual([])
    store.value = persisted({ __global__: [plugin(undefined)] })
    expect(await resolveDesktopAxAllowedApps(null)).toEqual([])
  })

  it('survives a corrupt persisted state', async () => {
    store.value = { state: { pluginsByProject: { __global__: 'not a list' } } }
    expect(await resolveDesktopAxAllowedApps(null)).toEqual([])
    store.value = persisted({ __global__: [{ id: 'other', desktopAllowedApps: ['Notes'] }] })
    expect(await resolveDesktopAxAllowedApps(null)).toEqual([])
  })

  it('normalizes names the way the tool compares them', () => {
    expect(
      normalizeAllowedApps(['  TextEdit  ', 'text edit', 'TextEdit', '', 42, 'Notes'])
    ).toEqual(['TextEdit', 'text edit', 'Notes'])
    expect(normalizeAllowedApps('not a list')).toEqual([])
    expect(normalizeAllowedApps([` ${'x'.repeat(200)} `])).toEqual(['x'.repeat(120)])
    expect(
      normalizeAllowedApps(Array.from({ length: 400 }, (_unused, index) => `app ${index}`))
    ).toHaveLength(200)
  })

  it('collapses internal whitespace without changing spelling', () => {
    expect(normalizeAllowedApps(['Gnome   Calculator'])).toEqual(['Gnome Calculator'])
  })
})
