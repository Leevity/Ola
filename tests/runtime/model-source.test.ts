import { describe, expect, it } from 'vitest'
import {
  legacyModelSource,
  parseModelSource,
  resolveModelBinding
} from '../../src/shared/runtime/model-source'
import { resolveAvailableModel, type ModelCatalog } from '../../src/runtime/providers/model-catalog'

const local = { kind: 'local' as const, providerId: 'lan', modelId: 'qwen' }
const managed = { kind: 'ola-team' as const, workspaceId: 'team-a', resourceId: 'chat' }
const catalog: ModelCatalog = {
  local: [{ id: 'lan', enabled: true, models: [{ id: 'qwen', enabled: true }] }],
  account: { authenticated: false, workspaces: [] }
}

describe('model source boundary', () => {
  it('uses local models without account authentication in any workspace', () => {
    for (const workspaceId of ['local-personal', 'personal-a', 'team-a', 'team-b'])
      expect(resolveAvailableModel({ workspaceId, session: local }, catalog)).toEqual(local)
  })
  it('freezes run > session > workspace selection', () => {
    const source = resolveModelBinding({ workspaceId: 'team-a', run: managed, session: local })
    expect(source).toEqual(managed)
    expect(Object.isFrozen(source)).toBe(true)
  })
  it('never falls through a revoked or unauthenticated binding', () => {
    expect(() =>
      resolveAvailableModel(
        { workspaceId: 'team-a', session: managed, workspaceDefault: local },
        catalog
      )
    ).toThrow('ACCOUNT_UNAVAILABLE')
    expect(() =>
      resolveAvailableModel(
        { workspaceId: 'team-a', session: managed, workspaceDefault: local },
        { ...catalog, account: { authenticated: true, workspaces: [] } }
      )
    ).toThrow('MODEL_UNAVAILABLE')
  })
  it('rejects cross-space resources, missing models and credential-bearing payloads', () => {
    expect(() => resolveModelBinding({ workspaceId: 'team-b', run: managed })).toThrow(
      'WORKSPACE_MISMATCH'
    )
    expect(() => resolveModelBinding({ workspaceId: 'team-a' })).toThrow('MODEL_NOT_SELECTED')
    for (const extra of [{ apiKey: 'secret' }, { token: 'ticket' }, { secretRef: 'vault-id' }])
      expect(() => parseModelSource({ ...managed, ...extra })).toThrow('INVALID_MODEL_SOURCE')
  })
  it('converts legacy managed ids only with known workspace kind', () => {
    expect(legacyModelSource('ola-managed:team-a', 'chat', 'ola-team')).toEqual(managed)
    expect(() => legacyModelSource('ola-managed:team-a', 'chat')).toThrow('WORKSPACE_MISMATCH')
    expect(() => parseModelSource({ ...local, providerId: 'ola-account-gateway' })).toThrow(
      'INVALID_MODEL_SOURCE'
    )
  })
})
