import { describe, expect, it } from 'vitest'
import { BrowserOwnershipRegistry } from '../../src/runtime/host/browser-ownership'

describe('browser ownership registry', () => {
  it('keeps a tab in its workspace and stops a run when a user takes control', () => {
    const registry = new BrowserOwnershipRegistry()
    registry.register({
      tabId: 'tab-1',
      workspaceId: 'team-a',
      profileId: 'workspace:team-a',
      createdBy: { kind: 'run', runId: 'run-1' }
    })
    const taken = registry.takeControl({
      tabId: 'tab-1',
      workspaceId: 'team-a',
      controller: { kind: 'user', windowId: 'window-1' }
    })
    expect(taken.displaced).toEqual({ kind: 'run', runId: 'run-1' })
    expect(registry.get('tab-1')?.controller).toEqual({ kind: 'user', windowId: 'window-1' })
    expect(() =>
      registry.takeControl({
        tabId: 'tab-1',
        workspaceId: 'team-a',
        controller: { kind: 'run', runId: 'run-2' }
      })
    ).toThrow('BROWSER_USER_IN_CONTROL')
    expect(() =>
      registry.takeControl({
        tabId: 'tab-1',
        workspaceId: 'team-b',
        controller: { kind: 'user', windowId: 'window-2' }
      })
    ).toThrow('WORKSPACE_MISMATCH')
  })

  it('allows an agent to claim an idle tab, then rejects it after user takeover', () => {
    const registry = new BrowserOwnershipRegistry()
    registry.register({
      tabId: 'tab-idle',
      workspaceId: 'local-personal',
      profileId: 'workspace:local-personal',
      createdBy: { kind: 'user', windowId: 'window-1' }
    })
    registry.releaseControl({
      tabId: 'tab-idle',
      workspaceId: 'local-personal',
      controller: { kind: 'user', windowId: 'window-1' }
    })
    registry.takeControl({
      tabId: 'tab-idle',
      workspaceId: 'local-personal',
      controller: { kind: 'run', runId: 'run-1' }
    })
    const takeover = registry.takeControl({
      tabId: 'tab-idle',
      workspaceId: 'local-personal',
      controller: { kind: 'user', windowId: 'window-1' }
    })
    expect(takeover.displaced).toEqual({ kind: 'run', runId: 'run-1' })
    expect(() =>
      registry.takeControl({
        tabId: 'tab-idle',
        workspaceId: 'local-personal',
        controller: { kind: 'run', runId: 'run-1' }
      })
    ).toThrow('BROWSER_USER_IN_CONTROL')
  })

  it('requires the current owner to release the browser control lease', () => {
    const registry = new BrowserOwnershipRegistry()
    registry.register({
      tabId: 'tab-2',
      workspaceId: 'local-personal',
      profileId: 'workspace:local-personal',
      createdBy: { kind: 'user', windowId: 'window-1' }
    })
    expect(() =>
      registry.releaseControl({
        tabId: 'tab-2',
        workspaceId: 'local-personal',
        controller: { kind: 'run', runId: 'run-1' }
      })
    ).toThrow('BROWSER_CONTROL_NOT_HELD')
    registry.releaseControl({
      tabId: 'tab-2',
      workspaceId: 'local-personal',
      controller: { kind: 'user', windowId: 'window-1' }
    })
    expect(registry.get('tab-2')?.controller).toBeNull()
  })
})
