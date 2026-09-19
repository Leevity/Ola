import { describe, expect, it } from 'vitest'
import { normalizeSshConfigDocument } from '../../src/main/ssh/ssh-config-json'
import { applySshImportPreview, previewOlaSshImport } from '../../src/main/ssh/ssh-import-ola'

const current = normalizeSshConfigDocument({
  groups: [{ id: 'old-group', name: 'Existing', createdAt: 1 }],
  connections: [
    {
      id: 'existing',
      name: 'Old',
      host: 'a.invalid',
      username: 'alice',
      password: 'old-secret',
      sortOrder: 8,
      createdAt: 10,
      updatedAt: 10
    }
  ]
})
const exported = {
  schemaVersion: 1,
  source: 'ola-ssh',
  groups: [{ id: 'import-group', name: 'Imported', createdAt: 2 }],
  connections: [
    {
      id: 'import-a',
      groupId: 'import-group',
      name: 'New A',
      host: 'a.invalid',
      username: 'alice',
      password: 'new-secret',
      createdAt: 2
    },
    {
      id: 'import-b',
      groupId: 'import-group',
      name: 'New B',
      host: 'b.invalid',
      username: 'bob',
      createdAt: 2
    }
  ]
}

describe('TS Ola SSH import', () => {
  it('previews exported and original Ola files with matching conflict decisions', () => {
    const preview = previewOlaSshImport(exported, current, '/export.json')
    expect(preview).toMatchObject({
      source: 'ola',
      connectionCount: 2,
      groups: ['Imported'],
      connections: [
        {
          importId: '0:New A:a.invalid:22:alice',
          defaultAction: 'skip',
          conflictConnectionId: 'existing'
        },
        { importId: '1:New B:b.invalid:22:bob', defaultAction: 'create' }
      ]
    })
    const original = previewOlaSshImport({ ssh: exported }, current, '/.ola.json')
    expect(original.warnings).toContain(
      'Detected original Ola config structure, imported as SSH segments.'
    )
    expect(() => previewOlaSshImport({}, current, '/bad.json')).toThrow(
      'Unsupported Ola SSH import file'
    )
    expect(
      previewOlaSshImport(
        { ...exported, connections: [exported.connections[0], exported.connections[0]] },
        current,
        '/duplicates.json'
      ).connections.map((row) => row.importId)
    ).toEqual(['0:New A:a.invalid:22:alice', '1:New A:a.invalid:22:alice'])
  })

  it('applies replace and create while preserving existing identity and timestamps', () => {
    const preview = previewOlaSshImport(exported, current, '/export.json')
    const { config, result } = applySshImportPreview(
      current,
      preview,
      [{ importId: preview.connections[0].importId, action: 'replace' }],
      100
    )
    expect(result).toMatchObject({ imported: 1, replaced: 1, duplicated: 0, skipped: 0 })
    expect(config.groups).toMatchObject([{ id: 'old-group' }, { name: 'Imported' }])
    expect(config.connections[0]).toMatchObject({
      id: 'existing',
      name: 'New A',
      password: 'new-secret',
      sortOrder: 8,
      createdAt: 10,
      updatedAt: 100
    })
    expect(config.connections[1]).toMatchObject({
      name: 'New B',
      groupId: config.groups[1].id,
      sortOrder: 9,
      createdAt: 100
    })
    expect(current.connections[0].password).toBe('old-secret')
  })

  it('does not create groups for skipped rows and gives duplicates distinct names', () => {
    const preview = previewOlaSshImport(exported, current, '/export.json')
    const skipped = applySshImportPreview(
      current,
      preview,
      [{ importId: preview.connections[1].importId, action: 'skip' }],
      100
    )
    expect(skipped.config.groups).toHaveLength(1)
    const duplicate = applySshImportPreview(
      current,
      preview,
      preview.connections.map((row) => ({ importId: row.importId, action: 'duplicate' })),
      100
    )
    expect(duplicate.result.duplicated).toBe(2)
    expect(duplicate.config.connections[1].name).toBe('New A (Imported)')
    expect(duplicate.config.connections[2].name).toBe('New B (Imported)')
  })
})
