import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  QqSessionFileStore,
  qqSessionAccountKey
} from '../../src/main/channels/providers/qq/session-file-store'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe('Main-owned QQ gateway session files', () => {
  it('isolates equal plugin IDs by workspace and avoids legacy sanitized-name collisions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-qq-sessions-'))
    directories.push(directory)
    const store = new QqSessionFileStore(directory, () => 1_000)
    const localKey = qqSessionAccountKey('local-personal', 'plugin:one')
    const teamKey = qqSessionAccountKey('team-a', 'plugin:one')
    const otherKey = qqSessionAccountKey('local-personal', 'plugin/one')
    expect(new Set([localKey, teamKey, otherKey]).size).toBe(3)
    const state = (accountId: string, sessionId: string) => ({
      accountId,
      sessionId,
      lastSeq: 7,
      lastConnectedAt: 900,
      intentLevelIndex: 1,
      savedAt: 900
    })
    await Promise.all([
      store.save(state(localKey, 'local-session')),
      store.save(state(teamKey, 'team-session')),
      store.save(state(otherKey, 'other-session'))
    ])
    expect((await store.load(localKey))?.sessionId).toBe('local-session')
    expect((await store.load(teamKey))?.sessionId).toBe('team-session')
    expect((await store.load(otherKey))?.sessionId).toBe('other-session')
    const files = await readdir(directory)
    expect(files).toHaveLength(3)
    if (process.platform !== 'win32') {
      for (const file of files) expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600)
    }
    await Promise.all([store.save(state(teamKey, 'updated-team')), store.clear(teamKey)])
    expect(await store.load(teamKey)).toBeNull()
    expect((await store.load(localKey))?.sessionId).toBe('local-session')
    await expect(store.load('plugin:one')).rejects.toThrow('INVALID_QQ_SESSION_ACCOUNT')
  })

  it('does not restore sessions beyond the gateway resume window', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ola-qq-expiry-'))
    directories.push(directory)
    let now = 1_000
    const store = new QqSessionFileStore(directory, () => now)
    const accountId = qqSessionAccountKey('team-a', 'qq-plugin')
    await store.save({
      accountId,
      sessionId: 'short-lived',
      lastSeq: 2,
      lastConnectedAt: now,
      intentLevelIndex: 0,
      savedAt: now
    })
    now += 5 * 60 * 1000 + 1
    expect(await store.load(accountId)).toBeNull()
  })
})
