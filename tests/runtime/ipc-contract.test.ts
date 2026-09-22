import { describe, expect, it } from 'vitest'
import { IPC, isKnownIpcChannel } from '../../src/shared/ipc/contract'

describe('shared IPC contract', () => {
  it('registers ordinary channels from the shared source', () => {
    expect(isKnownIpcChannel(IPC.SETTINGS_GET)).toBe(true)
    expect(isKnownIpcChannel(IPC.BROWSER_EXECUTE_SCRIPT)).toBe(true)
    expect(isKnownIpcChannel('unknown:channel')).toBe(false)
  })

  it('registers MessagePack base channels and legacy domain bridges', () => {
    expect(isKnownIpcChannel('db:messages:list')).toBe(true)
    expect(isKnownIpcChannel('image:download')).toBe(true)
    expect(isKnownIpcChannel('team-runtime:create')).toBe(true)
  })

  it('registers literal renderer channels and rejects unlisted prefixes', () => {
    expect(isKnownIpcChannel('settings:get')).toBe(true)
    expect(isKnownIpcChannel('app:unknown')).toBe(false)
  })
})
