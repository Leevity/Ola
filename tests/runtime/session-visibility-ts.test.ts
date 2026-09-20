import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearSessionVisibility,
  forgetSessionWindow,
  getSessionWindowIds,
  setSessionWindowVisibility
} from '../../src/main/ipc/session-visibility'

describe('TS session visibility registry', () => {
  beforeEach(() => clearSessionVisibility())

  it('tracks visible windows per session and removes empty entries', () => {
    setSessionWindowVisibility('session-a', 1, true)
    setSessionWindowVisibility('session-a', 2, true)
    setSessionWindowVisibility('session-b', 3, true)
    expect([...getSessionWindowIds('session-a')!].sort()).toEqual([1, 2])
    setSessionWindowVisibility('session-a', 1, false)
    expect([...getSessionWindowIds('session-a')!]).toEqual([2])
    setSessionWindowVisibility('session-a', 2, false)
    expect(getSessionWindowIds('session-a')).toBeUndefined()
  })

  it('forgets a window from every session during window teardown', () => {
    setSessionWindowVisibility('session-a', 7, true)
    setSessionWindowVisibility('session-b', 7, true)
    setSessionWindowVisibility('session-b', 8, true)
    forgetSessionWindow(7)
    expect(getSessionWindowIds('session-a')).toBeUndefined()
    expect([...getSessionWindowIds('session-b')!]).toEqual([8])
  })
})
