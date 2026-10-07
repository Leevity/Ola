import { beforeEach, expect, it, vi } from 'vitest'
import type { ExtensionInstance } from '../../src/shared/extension-types'

vi.mock('@renderer/lib/ipc/ipc-storage', () => ({
  ipcStorage: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined
  }
}))
vi.mock('@renderer/stores/chat-store', () => ({
  useChatStore: { getState: () => ({ activeProjectId: 'project-a' }) }
}))
vi.mock('@renderer/lib/extensions/extension-workbench', () => ({
  refreshExtensionWorkbenchContributions: async () => undefined
}))

import { useExtensionStore } from '../../src/renderer/src/stores/extension-store'
import { withRequestExtensionToolDefinitions } from '../../src/renderer/src/lib/extensions/extension-tools'

const extension: ExtensionInstance = {
  id: 'scope-e2e',
  enabled: true,
  installedAt: 1,
  updatedAt: 1,
  config: {},
  manifest: {
    schemaVersion: 1,
    id: 'scope-e2e',
    name: 'Scope fixture',
    version: '1.0.0',
    tools: [
      {
        name: 'lookup',
        description: 'Look up a record',
        kind: 'http',
        inputSchema: { type: 'object', properties: {} },
        http: { method: 'GET', url: 'https://example.invalid' }
      }
    ],
    views: [],
    commands: []
  }
}

beforeEach(() => {
  useExtensionStore.setState({
    extensions: [extension],
    activeExtensionIdsByProject: { 'project-a': [extension.id], __global__: [] }
  })
})

it('keeps an explicit global session separate from the active UI project', () => {
  const store = useExtensionStore.getState()
  expect(store.getActiveExtensionIds()).toEqual([extension.id])
  expect(store.getActiveExtensionIds(null)).toEqual([])
  store.toggleActiveExtension(extension.id, null)
  expect(store.getActiveExtensionIds(null)).toEqual([extension.id])
  expect(store.getActiveExtensionIds('project-a')).toEqual([extension.id])
  store.clearActiveExtensions(null)
  expect(store.getActiveExtensionIds(null)).toEqual([])
  expect(store.getActiveExtensionIds('project-a')).toEqual([extension.id])
})

it('builds Extension request definitions for the target session project', () => {
  useExtensionStore.setState({
    extensions: [
      extension,
      { ...extension, id: 'other', manifest: { ...extension.manifest, id: 'other' } }
    ],
    activeExtensionIdsByProject: { 'project-a': [extension.id], 'project-b': ['other'] }
  })
  const foregroundDefinitions = [
    { name: 'Read', description: 'Read', inputSchema: { type: 'object' as const, properties: {} } },
    {
      name: 'extension__scope-e2e__lookup',
      description: 'Stale',
      inputSchema: { type: 'object' as const, properties: {} }
    }
  ]
  expect(
    withRequestExtensionToolDefinitions(foregroundDefinitions, 'project-b').map((tool) => tool.name)
  ).toEqual(['Read', 'extension__other__lookup'])
  expect(
    withRequestExtensionToolDefinitions(foregroundDefinitions, null).map((tool) => tool.name)
  ).toEqual(['Read'])
})
