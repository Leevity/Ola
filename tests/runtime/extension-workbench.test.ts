import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionInstance } from '../../src/shared/extension-types'

const mockedState = vi.hoisted(() => ({
  extensions: [] as unknown[],
  activeIds: [] as string[],
  openView: vi.fn(),
  closeView: vi.fn(),
  currentView: null as null | { extensionId: string; view: { name: string } }
}))

vi.mock('@renderer/stores/chat-store', () => ({
  useChatStore: { getState: () => ({ activeProjectId: null }) }
}))
vi.mock('@renderer/stores/extension-store', () => ({
  useExtensionStore: {
    getState: () => ({
      extensions: mockedState.extensions,
      loadExtensions: async () => {},
      getActiveExtensionIds: () => mockedState.activeIds
    })
  }
}))
vi.mock('@renderer/stores/ui-store', () => ({
  useUIStore: {
    getState: () => ({
      extensionWorkbenchView: mockedState.currentView,
      openExtensionWorkbenchView: mockedState.openView,
      closeExtensionWorkbenchView: mockedState.closeView
    })
  }
}))

import { refreshExtensionWorkbenchContributions } from '../../src/renderer/src/lib/extensions/extension-workbench'
import {
  getWorkbenchAction,
  getWorkbenchActionsSnapshot
} from '../../src/renderer/src/lib/workbench/registry'

const extension: ExtensionInstance = {
  id: 'workbench-test',
  enabled: true,
  installedAt: 1,
  updatedAt: 1,
  config: {},
  manifest: {
    schemaVersion: 1,
    id: 'workbench-test',
    name: 'Workbench test',
    version: '1.0.0',
    tools: [],
    views: [{ name: 'dashboard', title: 'Dashboard', entry: 'views/dashboard.html' }],
    commands: [{ name: 'open-dashboard', title: 'Open dashboard', view: 'dashboard' }]
  }
}

describe('extension workbench contributions', () => {
  afterEach(async () => {
    mockedState.extensions = []
    mockedState.activeIds = []
    mockedState.currentView = null
    await refreshExtensionWorkbenchContributions()
    mockedState.openView.mockReset()
    mockedState.closeView.mockReset()
  })

  it('registers active extension commands and revokes them when an extension is disabled', async () => {
    mockedState.extensions = [extension]
    mockedState.activeIds = [extension.id]
    await refreshExtensionWorkbenchContributions()

    const actionId = `extension.${extension.id}.open-dashboard`
    expect(getWorkbenchActionsSnapshot()).toContainEqual(
      expect.objectContaining({ id: actionId, title: 'Open dashboard' })
    )
    await getWorkbenchAction(actionId)?.run()
    expect(mockedState.openView).toHaveBeenCalledWith(extension.id, extension.manifest.name, {
      name: 'dashboard',
      title: 'Dashboard',
      entry: 'views/dashboard.html'
    })
    mockedState.currentView = {
      extensionId: extension.id,
      view: { name: 'dashboard' }
    }

    mockedState.extensions = [{ ...extension, enabled: false }]
    await refreshExtensionWorkbenchContributions()
    expect(getWorkbenchAction(actionId)).toBeUndefined()
    expect(mockedState.closeView).toHaveBeenCalledOnce()
  })

  it('does not open an extension view through a stale command after deactivation', async () => {
    mockedState.extensions = [extension]
    mockedState.activeIds = [extension.id]
    await refreshExtensionWorkbenchContributions()

    mockedState.activeIds = []
    await getWorkbenchAction(`extension.${extension.id}.open-dashboard`)?.run()
    expect(mockedState.openView).not.toHaveBeenCalled()
  })
})
