import { expect, it } from 'vitest'
import { SshWorkspaceSwitchGate } from '../../src/main/ssh/ssh-workspace-switch-gate'

it('rejects a switch while SSH IPC is in flight and blocks new requests during a switch', () => {
  const gate = new SshWorkspaceSwitchGate()
  const releaseRequest = gate.beginRequest()
  expect(() => gate.beginSwitch(() => false)).toThrow('WORKSPACE_BUSY_SSH')
  releaseRequest()
  releaseRequest()

  const releaseSwitch = gate.beginSwitch(() => false)
  expect(() => gate.beginRequest()).toThrow('WORKSPACE_BUSY_SSH')
  expect(() => gate.beginSwitch(() => false)).toThrow('WORKSPACE_BUSY_SSH')
  releaseSwitch()
  releaseSwitch()
  const releaseNextRequest = gate.beginRequest()
  releaseNextRequest()
})

it('refuses a switch while a connected session or background transfer is active', () => {
  const gate = new SshWorkspaceSwitchGate()
  expect(() => gate.beginSwitch(() => true)).toThrow('WORKSPACE_BUSY_SSH')
  const release = gate.beginSwitch(() => false)
  release()
})
