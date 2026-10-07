import type { ToolDefinition } from '../../runtime/tools/tool-executor'
import { RuntimeError } from '../../shared/runtime/contracts'
import type { VideoGenerationRequest } from '../../shared/media-runtime'
import {
  createVideoTaskForWorkspace,
  getVideoCapabilitiesForWorkspace
} from '../ipc/media-runtime-handlers'

/** Async generation stays Main-owned; the runtime cannot supply workspace or session ownership. */
export function createVideoRuntimeTool(): ToolDefinition {
  return {
    name: 'GenerateVideo',
    description:
      'Generate a video asynchronously. Progress is shown in the video task card; completed media is indexed in results.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        providerId: { type: 'string' },
        model: { type: 'string' },
        firstFrameUrl: { type: 'string' },
        lastFrameUrl: { type: 'string' },
        aspectRatio: { type: 'string', enum: ['16:9', '9:16', '1:1', 'adaptive'] },
        durationSeconds: { type: 'number', enum: [5, 10] },
        resolution: { type: 'string', enum: ['720p', '1080p'] }
      },
      required: ['prompt']
    },
    effect: 'write',
    validate: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new RuntimeError('INVALID_TOOL_INPUT')
      const input = value as Record<string, unknown>
      if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16_384)
        throw new RuntimeError('INVALID_TOOL_INPUT')
      return input
    },
    resources: async (_input, context) => [`media:${context.run.workspaceId}`],
    execute: async (value, context) => {
      context.signal.throwIfAborted()
      const input = value as Record<string, unknown>
      const available = await getVideoCapabilitiesForWorkspace(context.run.workspaceId)
      const capability = input.providerId
        ? available.find((item) => item.providerId === input.providerId)
        : available[0]
      if (!capability) throw new RuntimeError('MODEL_UNAVAILABLE')
      const model = typeof input.model === 'string' ? input.model : capability.models[0]
      if (!capability.models.includes(model)) throw new RuntimeError('MODEL_UNAVAILABLE')
      const task = await createVideoTaskForWorkspace(
        {
          provider: capability.provider,
          providerId: capability.providerId,
          model,
          sessionId: context.run.sessionId,
          projectId: context.run.projectId,
          prompt: input.prompt as string,
          firstFrameUrl: input.firstFrameUrl as string | undefined,
          lastFrameUrl: input.lastFrameUrl as string | undefined,
          aspectRatio: input.aspectRatio as string | undefined,
          durationSeconds: input.durationSeconds as number | undefined,
          resolution: input.resolution as string | undefined
        } satisfies VideoGenerationRequest,
        context.run.workspaceId,
        async () => context.signal.throwIfAborted()
      )
      return JSON.stringify({
        type: 'video_generation_task',
        taskId: task.id,
        state: task.state,
        providerName: capability.providerName,
        model: task.model,
        prompt: task.prompt
      })
    }
  }
}
