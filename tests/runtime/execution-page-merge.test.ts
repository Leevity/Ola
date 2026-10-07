import { describe, expect, it } from 'vitest'
import {
  mergeExecutionPage,
  refreshedExecutionCursor
} from '../../src/renderer/src/lib/execution-page-merge'

describe('execution background page refresh', () => {
  it('restores a cursor when more than one page arrives after an exhausted list', () => {
    expect(refreshedExecutionCursor(null, 50, true)).toBe(50)
    expect(refreshedExecutionCursor(100, 50, true)).toBe(100)
    expect(refreshedExecutionCursor(100, null, false)).toBeNull()
  })
  it('updates terminal states, deduplicates new rows and retains already loaded pages', () => {
    const previous = [
      { id: 'active', status: 'running' },
      { id: 'older-page', status: 'completed' }
    ]
    const incoming = [
      { id: 'new', status: 'running' },
      { id: 'active', status: 'cancelled' }
    ]
    expect(mergeExecutionPage(previous, incoming, (item) => item.id)).toEqual([
      ...incoming,
      previous[1]
    ])
    expect(previous[0].status).toBe('running')
  })
})
