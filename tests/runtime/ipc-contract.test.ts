import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { IPC, isKnownIpcChannel } from '../../src/shared/ipc/contract'
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
    const drift = Object.keys(ipcChannelSchema).filter(
      (channel) => !isKnownIpcChannel(channel)
    )
    expect(drift).toEqual([])
  })
})
