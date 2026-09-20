import { describe, expect, it } from 'vitest'
import { resolveSplitSessionId } from '../../src/renderer/src/lib/workbench/conversation-split'

describe('conversation split selection', () => {
  const valid = new Set(['one', 'two'])

  it('opens a valid non-active session', () => {
    expect(resolveSplitSessionId('one', 'two', valid)).toBe('two')
  })

  it('rejects the active, missing, and unknown session', () => {
    expect(resolveSplitSessionId('one', 'one', valid)).toBeNull()
    expect(resolveSplitSessionId('one', null, valid)).toBeNull()
    expect(resolveSplitSessionId('one', 'gone', valid)).toBeNull()
  })
})
