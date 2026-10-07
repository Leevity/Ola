import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../src/runtime/tools/tool-executor'
const create = vi.hoisted(() =>
  vi.fn(async (_input: unknown, _workspace: string, _assert: unknown) => ({
    id: 'video-task',
    state: 'queued',
    model: 'video-model',
    prompt: 'Clip'
  }))
)
vi.mock('../../src/main/ipc/media-runtime-handlers', () => ({
  getVideoCapabilitiesForWorkspace: async () => [
    { provider: 'seedance', providerId: 'provider', providerName: 'Video', models: ['video-model'] }
  ],
  createVideoTaskForWorkspace: create
}))
import { createVideoRuntimeTool } from '../../src/main/runtime/video-runtime-tool'
const context = {
  run: { workspaceId: 'team-a', sessionId: 'session', projectId: 'project' },
  signal: new AbortController().signal
} as ToolContext
describe('Main video runtime tool', () => {
  it('binds ownership to the authorized run and returns the real asynchronous task card contract', async () => {
    const tool = createVideoRuntimeTool()
    const output = await tool.execute(
      { prompt: 'Clip', workspaceId: 'other', sessionId: 'other' },
      context
    )
    expect(create.mock.calls[0][0]).toMatchObject({
      sessionId: 'session',
      projectId: 'project',
      providerId: 'provider'
    })
    expect(create.mock.calls[0][1]).toBe('team-a')
    expect(JSON.parse(output as string)).toMatchObject({
      type: 'video_generation_task',
      taskId: 'video-task'
    })
    expect(tool.effect).toBe('write')
  })
  it('rejects missing prompts, unconfigured models, and aborted calls', async () => {
    const tool = createVideoRuntimeTool()
    expect(() => tool.validate({ prompt: '' })).toThrow('INVALID_TOOL_INPUT')
    await expect(tool.execute({ prompt: 'Clip', model: 'other' }, context)).rejects.toThrow(
      'MODEL_UNAVAILABLE'
    )
    const controller = new AbortController()
    controller.abort()
    await expect(
      tool.execute({ prompt: 'Clip' }, { ...context, signal: controller.signal })
    ).rejects.toThrow()
  })
})
