import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  browser: vi.fn(async () => ({ content: [{ type: 'text', text: 'Done' }] })),
  respond: vi.fn(async () => undefined)
}))

vi.mock('../../src/renderer/src/lib/tools/browser-native-ui', () => ({
  handleNativeBrowserToolRequest: mock.browser
}))
vi.mock('../../src/renderer/src/lib/ipc/ts-runtime-bridge', () => ({
  respondTsRuntimeInteraction: mock.respond
}))

import { resolveTsRuntimeBrowserInteraction } from '../../src/renderer/src/lib/ipc/browser-runtime-interaction'

describe('TS Browser interaction bridge', () => {
  beforeEach(() => {
    mock.browser.mockClear()
    mock.respond.mockClear()
  })
  it('dispatches only a matching session request and returns its tool result', async () => {
    const interaction = {
      runId: 'run',
      workspaceId: 'workspace',
      interactionId: 'browser-tool:call',
      kind: 'browser-tool' as const,
      payload: {
        toolName: 'BrowserNavigate',
        input: { url: 'https://example.com' },
        sessionId: 'session',
        projectId: 'project',
        workingFolder: '/work'
      },
      createdAt: 1
    }
    await resolveTsRuntimeBrowserInteraction(interaction, 'session')
    expect(mock.browser).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'BrowserNavigate',
        sessionId: 'session',
        agentRunId: 'run'
      })
    )
    expect(mock.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        response: { browserToolResult: [{ type: 'text', text: 'Done' }] }
      })
    )
  })

  it('rejects session mismatches without dispatching to the Browser UI', async () => {
    const interaction = {
      runId: 'run',
      workspaceId: 'workspace',
      interactionId: 'browser-tool:call',
      kind: 'browser-tool' as const,
      payload: {
        toolName: 'BrowserClick',
        input: { selector: 'button' },
        sessionId: 'other',
        projectId: null,
        workingFolder: null
      },
      createdAt: 1
    }
    await resolveTsRuntimeBrowserInteraction(interaction, 'session')
    expect(mock.browser).not.toHaveBeenCalled()
    expect(mock.respond).toHaveBeenLastCalledWith(
      expect.objectContaining({
        response: { browserToolResult: 'BROWSER_INTERACTION_INVALID', isError: true }
      })
    )
  })
})
