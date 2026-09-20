import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  SyncRecord,
  WorkspaceSyncBundle,
  WorkspaceSyncScope
} from '../../src/shared/sync-types'
import {
  hashSyncBundleContent,
  hashSyncRecordValue,
  verifyWorkspaceSyncBundle,
  workspaceSyncScopeHash
} from '../../src/shared/sync-bundle-contract'
import { mergeWorkspaceBundles } from '../../src/runtime/storage/workspace-sync-merge'

const scope: WorkspaceSyncScope = {
  accountId: 'account-1',
  apiBaseUrl: 'https://ola.example.test',
  workspaceId: 'team-a'
}

function record(
  domain: string,
  recordId: string,
  value: unknown,
  workspaceId = scope.workspaceId
): SyncRecord {
  return {
    domain,
    recordId,
    hash: hashSyncRecordValue(value),
    value,
    workspaceId
  }
}

function bundle(records: SyncRecord[], deviceId: string): WorkspaceSyncBundle {
  const manifestBase: Omit<WorkspaceSyncBundle['manifest'], 'contentHash'> = {
    schemaVersion: 2,
    appVersion: 'test',
    deviceId,
    createdAt: 1,
    scopeHash: workspaceSyncScopeHash(scope),
    domains: records.reduce<Record<string, number>>((counts, item) => {
      counts[item.domain] = (counts[item.domain] ?? 0) + 1
      return counts
    }, {}),
    tombstones: 0
  }
  return verifyWorkspaceSyncBundle(
    {
      manifest: {
        ...manifestBase,
        contentHash: hashSyncBundleContent(manifestBase, records, [])
      },
      records,
      tombstones: []
    },
    scope
  )
}

describe('workspace sync merge', () => {
  it('merges relational and direct workspace records in one bundle', () => {
    const local = bundle(
      [
        record('db:sessions', '["s1"]', {
          table: 'sessions',
          row: { id: 's1', workspace_id: 'team-a' }
        }),
        record('db:messages', '["m1"]', { table: 'messages', row: { id: 'm1', session_id: 's1' } })
      ],
      'device-a'
    )
    const remote = bundle(
      [
        record('db:sessions', '["s1"]', {
          table: 'sessions',
          row: { id: 's1', workspace_id: 'team-a' }
        }),
        record('db:messages', '["m1"]', { table: 'messages', row: { id: 'm1', session_id: 's1' } }),
        record('db:projects', '["p1"]', {
          table: 'projects',
          row: { id: 'p1', workspace_id: 'team-a' }
        })
      ],
      'device-b'
    )
    const result = mergeWorkspaceBundles({
      scope,
      local,
      remote,
      baseline: local.records.map((item) => ({
        domain: item.domain,
        recordId: item.recordId,
        contentHash: item.hash
      })),
      createdAt: 2
    })
    expect(result.status).toBe('ready')
    if (result.status === 'ready') {
      expect(result.bundle.records.map((item) => item.domain)).toEqual([
        'db:messages',
        'db:projects',
        'db:sessions'
      ])
      expect(result.recordsToApply).toHaveLength(1)
    }
  })

  it('requires an explicit resolution for a cross-domain conflict', () => {
    const local = bundle(
      [record('db:messages', '["m1"]', { table: 'messages', row: { id: 'm1', content: 'local' } })],
      'a'
    )
    const remote = bundle(
      [
        record('db:messages', '["m1"]', { table: 'messages', row: { id: 'm1', content: 'remote' } })
      ],
      'b'
    )
    const baseline = [
      {
        domain: 'db:messages',
        recordId: '["m1"]',
        contentHash: createHash('sha256').update('base').digest('hex')
      }
    ]
    const conflict = mergeWorkspaceBundles({ scope, local, remote, baseline, createdAt: 2 })
    expect(conflict.status).toBe('conflict')
    if (conflict.status === 'conflict') {
      const resolved = mergeWorkspaceBundles({
        scope,
        local,
        remote,
        baseline,
        resolutions: [{ conflictId: conflict.conflicts[0].id, choice: 'remote' }],
        createdAt: 2
      })
      expect(resolved.status).toBe('ready')
      if (resolved.status === 'ready')
        expect(resolved.bundle.records[0].value).toEqual(remote.records[0].value)
    }
  })

  it('rejects a record explicitly owned by another workspace', () => {
    expect(() =>
      bundle(
        [
          record(
            'db:messages',
            '["m1"]',
            { table: 'messages', row: { id: 'm1', content: 'cross' } },
            'team-b'
          )
        ],
        'bad'
      )
    ).toThrow('SYNC_BUNDLE_WORKSPACE_MISMATCH')
  })
})
