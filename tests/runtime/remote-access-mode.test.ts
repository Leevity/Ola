import { afterEach, describe, expect, it } from 'vitest'
import {
  accessSnapshot,
  applyAccessMode,
  beginRemoteSession,
  bindRunToSession,
  endRemoteSession,
  requestAutoApproval
} from '../../src/main/remote/access-mode'
import {
  currentRemoteAccessMode,
  isInputSessionAuthorized,
  setAuthorizedInputSession
} from '../../src/main/remote/authorization-state'

afterEach(() => {
  applyAccessMode('none')
  endRemoteSession()
})

describe('remote access mode', () => {
  it('starts closed and refuses automatic approval until unattended is set', () => {
    expect(currentRemoteAccessMode()).toBe('none')
    beginRemoteSession('session-1')
    bindRunToSession('run-1')
    expect(requestAutoApproval('run-1')).toEqual({ approved: false, reason: 'not-unattended' })
  })

  it('revoking access drops the live input session immediately', () => {
    applyAccessMode('attended')
    setAuthorizedInputSession('session-1')
    expect(isInputSessionAuthorized('session-1')).toBe(true)

    applyAccessMode('none')
    expect(isInputSessionAuthorized('session-1')).toBe(false)
  })

  it('only approves runs that were bound while the session was open', () => {
    applyAccessMode('unattended')
    beginRemoteSession('session-1')
    // A run submitted before the session opened has no binding.
    expect(requestAutoApproval('local-run')).toEqual({ approved: false, reason: 'run-not-bound' })

    bindRunToSession('remote-run')
    expect(requestAutoApproval('remote-run')).toEqual({ approved: true, sessionId: 'session-1' })
  })

  it('stops approving once the session ends', () => {
    applyAccessMode('unattended')
    beginRemoteSession('session-1')
    bindRunToSession('remote-run')
    expect(requestAutoApproval('remote-run').approved).toBe(true)

    endRemoteSession('session-1')
    expect(requestAutoApproval('remote-run')).toEqual({ approved: false, reason: 'no-session' })
  })

  it('counts approvals so the autonomy budget is visible', () => {
    applyAccessMode('unattended')
    beginRemoteSession('session-1')
    bindRunToSession('run-1')
    const before = accessSnapshot().autoApprovalsUsed
    requestAutoApproval('run-1')
    requestAutoApproval('run-1')
    const snapshot = accessSnapshot()
    expect(snapshot.autoApprovalsUsed).toBe(before + 2)
    expect(snapshot.autoApprovalsLimit).toBeGreaterThan(0)
    expect(snapshot.mode).toBe('unattended')
  })

  it('clears bindings when access is revoked', () => {
    applyAccessMode('unattended')
    beginRemoteSession('session-1')
    bindRunToSession('run-1')
    applyAccessMode('none')
    applyAccessMode('unattended')
    beginRemoteSession('session-2')
    expect(requestAutoApproval('run-1')).toEqual({ approved: false, reason: 'run-not-bound' })
  })
})
