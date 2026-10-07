import { describe, expect, it, vi } from 'vitest'
import { ToolExecutor } from '../../src/runtime/tools/tool-executor'
import { createBrowserRuntimeTools } from '../../src/main/runtime/browser-runtime-tools'
import { RuntimeError } from '../../src/shared/runtime/contracts'

const browserMocks = vi.hoisted(() => ({
  fromId: vi.fn(() => ({ isDestroyed: () => false, getURL: () => 'https://example.com/' })),
  find: vi.fn(() => ({
    ownership: { tabId: 'tab-1' },
    hostWebContentsId: 10,
    guestWebContentsId: 20
  })),
  takeControl: vi.fn(() => undefined),
  capture: vi.fn(async () => ({
    data: 'cG5n',
    mediaType: 'image/png' as const,
    width: 640,
    height: 480
  })),
  stage: vi.fn(async () => ({ assetId: '12345678-1234-1234-1234-123456789abc', bytes: 4 }))
}))
vi.mock('electron', () => ({ webContents: { fromId: browserMocks.fromId } }))
vi.mock('../../src/main/browser/browser-service', () => ({
  findBrowserUserTab: browserMocks.find,
  takeBrowserRunControl: browserMocks.takeControl,
  captureRegisteredBrowserGuest: browserMocks.capture
}))
vi.mock('../../src/runtime/storage/runtime-image-assets', () => ({
  stageRuntimeImageAsset: browserMocks.stage
}))
vi.mock('../../src/main/ipc/secure-key-store', () => ({ getConfigValue: async () => null }))

describe('Main Browser runtime tool contracts', () => {
  it('enforces schemas and classifies page mutations as approved writes', () => {
    const tools = createBrowserRuntimeTools()
    const navigate = tools.find((tool) => tool.name === 'BrowserNavigate')!
    const click = tools.find((tool) => tool.name === 'BrowserClick')!
    const read = tools.find((tool) => tool.name === 'BrowserGetContent')!
    expect(navigate.effect).toBe('write')
    expect(click.effect).toBe('write')
    expect(read.effect).toBe('read')
    expect(() => click.validate({ selector: 'button', surprise: true })).toThrowError(RuntimeError)
    expect(() =>
      tools
        .find((tool) => tool.name === 'BrowserType')!
        .validate({ selector: '#q', text: 'x'.repeat(16_385) })
    ).toThrowError(RuntimeError)
  })

  it('requests a session-bound renderer operation after checking Main domain policy', async () => {
    const navigate = createBrowserRuntimeTools().find((tool) => tool.name === 'BrowserNavigate')!
    let requested: unknown
    const context = {
      run: {
        runId: 'run-1',
        taskId: 'task',
        requestId: 'request',
        traceId: 'trace',
        sessionId: 'session-1',
        projectId: 'project-1',
        workspaceId: 'local-personal',
        environmentId: 'local',
        modelSource: { kind: 'local', providerId: 'p', modelId: 'm' },
        prompt: 'browse',
        toolNames: ['BrowserNavigate'],
        unattended: false,
        workingDirectory: 'C:\\project'
      },
      toolCallId: 'call-1',
      signal: new AbortController().signal,
      requestInteraction: async (interaction: unknown) => {
        requested = interaction
        return { browserToolResult: { success: true } }
      }
    } as never
    await expect(
      navigate.execute(navigate.validate({ url: 'example.com' }), context)
    ).resolves.toEqual({ success: true })
    expect(requested).toMatchObject({
      interactionId: 'browser-tool:call-1',
      kind: 'browser-tool',
      payload: {
        toolName: 'BrowserNavigate',
        input: { url: 'example.com' },
        sessionId: 'session-1',
        projectId: 'project-1'
      }
    })
  })

  it('captures screenshots in Main and passes only a staged image asset to the model', async () => {
    const screenshot = createBrowserRuntimeTools().find(
      (tool) => tool.name === 'BrowserScreenshot'
    )!
    const run = {
      runId: 'run-1',
      taskId: 'task',
      requestId: 'request',
      traceId: 'trace',
      sessionId: 'session-1',
      projectId: 'project-1',
      workspaceId: 'local-personal',
      environmentId: 'local',
      modelSource: { kind: 'local', providerId: 'p', modelId: 'm' },
      prompt: 'inspect',
      toolNames: ['BrowserScreenshot'],
      unattended: false
    }
    const context = { run, signal: new AbortController().signal } as never
    const executor = new ToolExecutor([screenshot], async () => true)
    const result = await executor.executeAll(
      [{ id: 'shot', name: 'BrowserScreenshot', input: {} }],
      context,
      async () => undefined
    )
    expect(result[0]).toMatchObject({
      output: 'Screenshot captured: 640x480px - https://example.com/',
      images: [{ mimeType: 'image/png', assetId: '12345678-1234-1234-1234-123456789abc' }]
    })
    expect(browserMocks.stage).toHaveBeenCalledWith({
      workspaceId: 'local-personal',
      mimeType: 'image/png',
      base64: 'cG5n'
    })
    expect(browserMocks.takeControl).toHaveBeenCalledWith({
      tabId: 'tab-1',
      hostWebContentsId: 10,
      runId: 'run-1'
    })
  })
})
