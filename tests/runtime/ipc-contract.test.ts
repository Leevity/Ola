import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { IPC, isKnownIpcChannel, isKnownIpcTransportChannel } from '../../src/shared/ipc/contract'
import { ipcChannelSchema } from '../../src/shared/ipc/types'

// All renderer-facing channels must be covered by the IPC literal itself, so
// the known set is derived from IPC. Binary (MessagePack) channels and legacy
// window bridges live on top of the JSON contract.
const known = new Set<string>([...Object.values(IPC)])

function collectRendererChannels(): Set<string> {
  const channels = new Set<string>()
  const root = 'src/renderer/src'
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) visit(p)
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const source = readFileSync(p, 'utf8')
        for (const method of ['invoke', 'send', 'on']) {
          const pattern = new RegExp(`ipcClient\\.${method}\\(\\s*['"]([^'"]+)['"]`, 'g')
          for (const match of source.matchAll(pattern)) channels.add(match[1])
        }
      }
    }
  }
  visit(root)
  return channels
}

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
    expect(isKnownIpcChannel('execution-records:list:msgpack')).toBe(true)
    expect(isKnownIpcChannel('execution-artifacts:list:msgpack')).toBe(true)
    expect(isKnownIpcChannel('execution-artifacts:hide:msgpack')).toBe(true)
  })

  it('permits binary transport only for registered IPC bases', () => {
    expect(isKnownIpcTransportChannel('api:quota-update:msgpack')).toBe(true)
    expect(isKnownIpcTransportChannel('execution-artifacts:list:msgpack')).toBe(true)
    expect(isKnownIpcTransportChannel('ts-runtime:run-snapshot:msgpack')).toBe(true)
    expect(isKnownIpcTransportChannel('ts-runtime:runs-list:msgpack')).toBe(true)
    expect(isKnownIpcTransportChannel('ts-runtime:run-submit:msgpack')).toBe(true)
    expect(isKnownIpcTransportChannel('unknown:channel:msgpack')).toBe(false)
    expect(isKnownIpcTransportChannel('api:quota-update:msgpack:msgpack')).toBe(false)
  })

  it('registers literal renderer channels and rejects unlisted prefixes', () => {
    expect(isKnownIpcChannel('settings:get')).toBe(true)
    expect(isKnownIpcChannel('app:unknown')).toBe(false)
  })

  it('registers every literal channel used by the renderer (no backdoor)', () => {
    const used = collectRendererChannels()
    const missing = [...used].filter((channel) => !known.has(channel)).sort()
    expect(missing).toEqual([])
    expect(used.size).toBeGreaterThan(50)
  })

  it('keeps every schema key aligned with a registered channel', () => {
    const drift = Object.keys(ipcChannelSchema).filter((channel) => !isKnownIpcChannel(channel))
    expect(drift).toEqual([])
  })

  it('requires a schema for every high-sensitivity channel', () => {
    // High-risk invoke channels (fs/shell/credentials/browser/runtime) must be
    // pinned in the schema so their payload shapes are documented and typed
    // instead of silently falling through to `unknown`. Push/notification
    // channels (e.g. `*-output`, `*-started`, `*-changed`, `*-event`) carry no
    // request/response pair and are excluded. Any new invoke channel under
    // these prefixes must be added to `ipcChannelSchema` together with its
    // registration.
    const highRiskPrefixes = ['fs:', 'shell:', 'credentials:', 'browser:', 'runtime:']
    const pushSuffixes = [
      'output',
      'started',
      'created',
      'exit',
      'changed',
      'event',
      'sync-event',
      'incoming-message',
      'file-changed',
      'dir-changed',
      'approval-request:msgpack'
    ]
    const isPush = (channel: string): boolean =>
      pushSuffixes.some((suffix) => channel.endsWith(suffix))
    const highRiskChannels = Object.values(IPC).filter(
      (channel) => highRiskPrefixes.some((prefix) => channel.startsWith(prefix)) && !isPush(channel)
    )
    const missing = highRiskChannels.filter((channel) => !(channel in ipcChannelSchema)).sort()
    expect(missing).toEqual([])
  })
})
