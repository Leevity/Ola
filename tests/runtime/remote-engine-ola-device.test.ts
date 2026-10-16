import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  screen: {
    getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 } }],
    getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 } })
  }
}))

vi.mock('../../src/main/ipc/desktop-control', () => ({
  desktopInputClick: vi.fn(() => ({ success: true as const })),
  desktopInputMove: vi.fn(() => ({ success: true as const })),
  desktopInputScroll: vi.fn(() => ({ success: true as const })),
  desktopInputType: vi.fn(() => ({ success: true as const }))
}))

vi.mock('../../src/main/remote/connection-store', () => ({
  getRemoteConnection: vi.fn(),
  markRemoteConnectionConnected: vi.fn()
}))

vi.mock('../../src/main/remote/rdp/rdp-cleanpath-bridge', () => ({
  createRdpCleanPathBridge: vi.fn()
}))

vi.mock('../../src/main/remote/vnc/novnc-proxy', () => ({
  launchNoVncProxy: vi.fn()
}))

vi.mock('../../src/main/credentials/secret-vault', () => ({
  getCredentialEntryForInjection: vi.fn(),
  getCredentialRef: vi.fn(),
  touchCredential: vi.fn()
}))

import { setRemoteControlAllowed } from '../../src/main/remote/authorization-state'
import { RemoteControlEngine } from '../../src/main/remote/engine'

describe('incoming Ola mobile remote sessions', () => {
  let engine: RemoteControlEngine

  beforeEach(() => {
    setRemoteControlAllowed(false)
    engine = new RemoteControlEngine()
  })

  afterEach(() => {
    engine.sessions.disconnectAll()
    setRemoteControlAllowed(false)
  })

  it('rejects session creation until desktop remote control is authorized', () => {
    expect(() => engine.createIncomingOlaDeviceSession('session-1', 41, 'mobile-1')).toThrow(
      'Desktop remote control is disabled'
    )
    expect(engine.sessions.list()).toEqual([])
  })

  it('creates an owned Ola device session and prevents another window from claiming or closing it', () => {
    setRemoteControlAllowed(true)

    const session = engine.createIncomingOlaDeviceSession('session-1', 41, 'mobile-1')

    expect(session).toMatchObject({
      id: 'session-1',
      kind: 'ola-device',
      status: 'connected',
      viewerDestination: 'mobile-1',
      credentialAvailable: false
    })
    expect(engine.sessions.isOwnedBy('session-1', 41)).toBe(true)
    expect(engine.sessions.isOwnedBy('session-1', 42)).toBe(false)
    expect(() => engine.createIncomingOlaDeviceSession('session-1', 42, 'attacker')).toThrow(
      'Remote session is owned by another window'
    )

    engine.disconnectIncomingOlaDeviceSession('session-1', 42)
    expect(engine.sessions.list()[0]).toMatchObject({ id: 'session-1', status: 'connected' })

    engine.disconnectIncomingOlaDeviceSession('session-1', 41)
    expect(engine.sessions.list()[0]).toMatchObject({ id: 'session-1', status: 'disconnected' })
  })
})
