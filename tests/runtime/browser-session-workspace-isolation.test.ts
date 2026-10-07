import { afterAll, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const electronSessions = vi.hoisted(() => {
  const defaultSession = { id: 'external-default' }
  const partitions = new Map<string, { id: string }>()
  return { defaultSession, partitions }
})

vi.mock('electron', () => ({
  app: { getPath: () => 'isolated-electron-user-data' },
  session: {
    defaultSession: electronSessions.defaultSession,
    fromPartition: (partition: string) => {
      let value = electronSessions.partitions.get(partition)
      if (!value) {
        value = { id: partition }
        electronSessions.partitions.set(partition, value)
      }
      return value
    }
  }
}))
vi.mock('../../src/main/ipc/settings-handlers', () => ({
  readSettings: () => ({ 'ola-settings': { state: { browserUserDataReuseEnabled: true } } })
}))

import {
  getBuiltInBrowserSession,
  getBuiltInBrowserStorageSessions
} from '../../src/main/browser/browser-emulation'

let isolatedRoot: string | undefined
const previousRoot = process.env.OLA_E2E_DATA_ROOT

afterAll(async () => {
  if (previousRoot === undefined) delete process.env.OLA_E2E_DATA_ROOT
  else process.env.OLA_E2E_DATA_ROOT = previousRoot
  if (isolatedRoot) await rm(isolatedRoot, { recursive: true, force: true })
})

it('keeps managed workspace browser sessions separate when external data reuse is enabled', async () => {
  isolatedRoot = await mkdtemp(join(tmpdir(), 'ola-browser-session-workspace-'))
  await writeFile(join(isolatedRoot, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
  process.env.OLA_E2E_DATA_ROOT = isolatedRoot

  const personal = getBuiltInBrowserSession('local-personal')
  const teamA = getBuiltInBrowserSession('team-a')
  const teamB = getBuiltInBrowserSession('team-b')

  expect(personal).toBe(electronSessions.defaultSession)
  expect(teamA).not.toBe(personal)
  expect(teamB).not.toBe(teamA)
  expect(teamA).toEqual({ id: 'persist:ola-browser-team-a' })
  expect(getBuiltInBrowserStorageSessions(['team-a'])).toEqual([teamA])
})
