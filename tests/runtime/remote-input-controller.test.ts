import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { desktopInputClick, desktopInputMove, desktopInputScroll, desktopInputType } = vi.hoisted(
  () => ({
    desktopInputClick: vi.fn(() => ({ success: true as const })),
    desktopInputMove: vi.fn(() => ({ success: true as const })),
    desktopInputScroll: vi.fn(() => ({ success: true as const })),
    desktopInputType: vi.fn(() => ({ success: true as const }))
  })
)

vi.mock('electron', () => ({
  screen: {
    getAllDisplays: () => [{ id: 1, bounds: { x: 100, y: 200, width: 800, height: 600 } }],
    getPrimaryDisplay: () => ({ id: 1, bounds: { x: 100, y: 200, width: 800, height: 600 } })
  }
}))

vi.mock('../../src/main/ipc/desktop-control', () => ({
  desktopInputClick,
  desktopInputMove,
  desktopInputScroll,
  desktopInputType
}))

import { setRemoteControlAllowed } from '../../src/main/remote/authorization-state'
import {
  clearRemoteInputSession,
  clearRemoteInputSessionIfOwned,
  dispatchRemoteInput,
  setRemoteInputSession
} from '../../src/main/remote/input-controller'

describe('remote desktop input revocation', () => {
  beforeEach(() => {
    setRemoteControlAllowed(false)
    vi.clearAllMocks()
    setRemoteControlAllowed(true)
    setRemoteInputSession('remote-session-1', '1', 41)
  })

  afterEach(() => {
    setRemoteInputSession(null)
    setRemoteControlAllowed(false)
  })

  it('releases held keyboard and pointer inputs immediately when remote control is revoked', () => {
    expect(
      dispatchRemoteInput({
        sessionId: 'remote-session-1',
        event: { type: 'key', key: 'A', action: 'down' }
      })
    ).toEqual({ success: true })
    expect(
      dispatchRemoteInput({
        sessionId: 'remote-session-1',
        event: { type: 'pointerButton', x: 0.5, y: 0.5, button: 'left', action: 'down' }
      })
    ).toEqual({ success: true })

    setRemoteControlAllowed(false)

    expect(desktopInputType).toHaveBeenNthCalledWith(2, { key: 'A', action: 'up', modifiers: [] })
    expect(desktopInputClick).toHaveBeenNthCalledWith(2, {
      x: 500,
      y: 500,
      button: 'left',
      action: 'up'
    })
    expect(
      dispatchRemoteInput({
        sessionId: 'remote-session-1',
        event: { type: 'key', key: 'B', action: 'down' }
      })
    ).toMatchObject({ success: false })
  })

  it('releases held inputs when the owning renderer disconnects its session', () => {
    dispatchRemoteInput({
      sessionId: 'remote-session-1',
      event: { type: 'key', key: 'Enter', action: 'down' }
    })

    expect(clearRemoteInputSessionIfOwned('remote-session-1', 41)).toBe(true)

    expect(desktopInputType).toHaveBeenNthCalledWith(2, {
      key: 'Enter',
      action: 'up',
      modifiers: []
    })
    expect(
      dispatchRemoteInput({
        sessionId: 'remote-session-1',
        event: { type: 'key', key: 'Enter', action: 'down' }
      })
    ).toMatchObject({ success: false })
  })

  it('does not let another renderer clear the active owner session', () => {
    expect(clearRemoteInputSession(99)).toBe(false)
    expect(
      dispatchRemoteInput({
        sessionId: 'remote-session-1',
        event: { type: 'pointerMove', x: 0.25, y: 0.75 }
      })
    ).toEqual({ success: true })
    expect(desktopInputMove).toHaveBeenCalledWith(300, 650)
  })
})
