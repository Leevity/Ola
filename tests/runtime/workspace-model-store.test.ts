import { describe, expect, it } from 'vitest'
import { useWorkspaceStore } from '../../src/renderer/src/stores/workspace-store'

describe('desktop explicit model-source integration', () => {
  it('writes typed defaults, keeps legacy compatibility and preserves revoked bindings', () => {
    useWorkspaceStore.setState({
      activeWorkspaceId: 'local-personal',
      modelSelections: {},
      modelSources: {},
      olaWorkspaces: [],
      resourcesByWorkspace: {}
    })
    const store = () => useWorkspaceStore.getState()
    store().setModelSelection('local-personal', { providerId: 'lan', modelId: 'm' })
    expect(store().modelSources['local-personal']).toEqual({
      kind: 'local',
      providerId: 'lan',
      modelId: 'm'
    })
    store().replaceOlaWorkspaces([
      { id: 'a', kind: 'ola-team', name: 'A' },
      { id: 'b', kind: 'ola-team', name: 'B' }
    ])
    store().setModelSelection('a', { providerId: 'ola-managed:a', modelId: 'r' })
    store().setModelSelection('b', { providerId: 'ola-managed:a', modelId: 'r' })
    expect(store().getModelSelection('b')).toBeUndefined()
    expect(store().modelSources.a).toEqual({ kind: 'ola-team', workspaceId: 'a', resourceId: 'r' })
    store().clearOlaState()
    expect(store().getModelSelection('a')).toEqual({ providerId: 'ola-managed:a', modelId: 'r' })
    expect(store().getModelSelection('local-personal')).toEqual({ providerId: 'lan', modelId: 'm' })
    // A directory response that started before logout cannot repopulate a revoked account.
    store().setResources('a', [
      {
        id: 'late',
        workspaceId: 'a',
        providerName: 'Ola',
        model: 'late-model',
        enabled: true,
        isDefault: false
      }
    ])
    expect(store().resourcesByWorkspace).toEqual({})
    useWorkspaceStore.setState({
      modelSelections: { legacy: { providerId: 'old', modelId: 'old-model' } }
    })
    expect(store().getModelSelection('legacy')).toEqual({ providerId: 'old', modelId: 'old-model' })
  })
  it('separates auxiliary choices without changing the main model', () => {
    useWorkspaceStore.setState({ modelSelections: {}, modelSources: {} })
    const store = () => useWorkspaceStore.getState()
    store().setModelSelection('local-personal', { providerId: 'lan', modelId: 'main' })
    const key = JSON.stringify(['local-personal', 'translation'])
    store().setModelSelection(key, { providerId: 'lan', modelId: 'translate' })
    expect(store().getModelSelection(key)?.modelId).toBe('translate')
    expect(store().getModelSelection('local-personal')?.modelId).toBe('main')
  })

  it('uses the validated ModelSource instead of a stale legacy selection entry', () => {
    useWorkspaceStore.setState({
      activeWorkspaceId: 'local-personal',
      olaWorkspaces: [],
      modelSelections: {
        'local-personal': { providerId: 'stale-provider', modelId: 'stale-model' }
      },
      modelSources: {
        'local-personal': { kind: 'local', providerId: 'bound-provider', modelId: 'bound-model' }
      }
    })
    expect(useWorkspaceStore.getState().getModelSelection('local-personal')).toEqual({
      providerId: 'bound-provider',
      modelId: 'bound-model'
    })
  })

  it('fails closed when a persisted typed binding is invalid', () => {
    useWorkspaceStore.setState({
      modelSelections: {
        'local-personal': { providerId: 'stale-provider', modelId: 'stale-model' }
      },
      modelSources: {
        'local-personal': { kind: 'local', providerId: 'ola-managed:wrong', modelId: 'resource' }
      }
    })

    expect(useWorkspaceStore.getState().getModelSelection('local-personal')).toBeUndefined()
  })
})
