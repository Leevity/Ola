import { describe, expect, it } from 'vitest'
import {
  closeSessionTab,
  MAX_WORKBENCH_SESSION_TABS,
  normalizeSessionTabIds,
  normalizeSessionTabScopes,
  openSessionTab,
  pruneSessionTabs,
  reorderSessionTab
} from '../../src/renderer/src/lib/workbench/session-tabs'
import { workspaceLayoutStorageKey } from '../../src/renderer/src/lib/workbench/workspace-layout'

describe('workspace session tabs', () => {
  it('keeps order stable, bounds persistence, and selects a neighbor on close', () => {
    expect(openSessionTab(['a', 'b'], 'a')).toEqual(['a', 'b'])
    expect(openSessionTab(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
    expect(closeSessionTab(['a', 'b', 'c'], 'b', 'b')).toEqual({
      tabs: ['a', 'c'],
      nextSessionId: 'c'
    })
    expect(closeSessionTab(['a', 'b'], 'b', 'b')).toEqual({
      tabs: ['a'],
      nextSessionId: 'a'
    })
    expect(closeSessionTab(['a'], 'a', 'a')).toEqual({ tabs: [], nextSessionId: null })
    expect(closeSessionTab(['a', 'b'], 'a', 'b')).toEqual({
      tabs: ['b'],
      nextSessionId: 'b'
    })
    const many = Array.from({ length: MAX_WORKBENCH_SESSION_TABS + 3 }, (_, index) => `s-${index}`)
    expect(normalizeSessionTabIds(many)).toEqual(many.slice(-MAX_WORKBENCH_SESSION_TABS))
  })

  it('rejects malformed persisted IDs and prunes deleted or cross-workspace sessions', () => {
    expect(normalizeSessionTabIds(['a', null, 'a', '', 5, 'b'])).toEqual(['a', 'b'])
    expect(pruneSessionTabs(['personal', 'team'], new Set(['team']))).toEqual(['team'])
    const personalKey = workspaceLayoutStorageKey('local-personal', 'primary')
    const teamKey = workspaceLayoutStorageKey('team-a', 'primary')
    expect(
      normalizeSessionTabScopes({
        [personalKey]: ['personal'],
        [teamKey]: ['team'],
        broken: ['other'],
        'window:bad': 'not-an-array'
      })
    ).toEqual({ [personalKey]: ['personal'], [teamKey]: ['team'] })
  })

  it('reorders tabs without accepting unknown or cross-scope ids', () => {
    expect(reorderSessionTab(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(reorderSessionTab(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'a', 'c'])
    expect(reorderSessionTab(['a', 'b'], 'missing', 'a')).toEqual(['a', 'b'])
    expect(reorderSessionTab(['a', 'b'], 'a', 'missing')).toEqual(['a', 'b'])
  })
})
