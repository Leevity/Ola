import { toolRegistry } from '../agent/tool-registry'
import { encodeStructuredToolResult } from './tool-result-format'
import type {
  MediaRuntimeStatus,
  VideoGenerationRequest,
  VideoTask
} from '../../../../shared/media-runtime'
import type { ToolHandler } from './tool-types'

const videoGenerationHandler: ToolHandler = {
  definition: {
    name: 'GenerateVideo',
    description:
      'Create one asynchronous video generation task. Returns a task ID immediately; progress is shown in a dedicated chat card.',
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
    }
  },
  execute: async (input, context) => {
    const status = (await context.ipc.invoke('media:status')) as MediaRuntimeStatus
    if (!status.settings.videoGenerationEnabled) throw new Error('Video generation is disabled')
    const capability =
      status.capabilities.find((item) => item.providerId === input.providerId) ??
      status.capabilities[0]
    if (!capability) throw new Error('No enabled video generation model is configured')
    const model =
      typeof input.model === 'string' && capability.models.includes(input.model)
        ? input.model
        : capability.models[0]
    if (!model) throw new Error('The selected video provider has no available model')
    const request: VideoGenerationRequest = {
      provider: capability.provider,
      providerId: capability.providerId,
      model,
      prompt: typeof input.prompt === 'string' ? input.prompt : '',
      ...(typeof input.firstFrameUrl === 'string' ? { firstFrameUrl: input.firstFrameUrl } : {}),
      ...(typeof input.lastFrameUrl === 'string' ? { lastFrameUrl: input.lastFrameUrl } : {}),
      ...(typeof input.aspectRatio === 'string' ? { aspectRatio: input.aspectRatio } : {}),
      ...(typeof input.durationSeconds === 'number'
        ? { durationSeconds: input.durationSeconds }
        : {}),
      ...(typeof input.resolution === 'string' ? { resolution: input.resolution } : {})
    }
    const task = (await context.ipc.invoke('media:task-create', request)) as VideoTask
    return encodeStructuredToolResult({
      type: 'video_generation_task',
      taskId: task.id,
      state: task.state,
      providerName: capability.providerName,
      model: task.model,
      prompt: task.prompt
    })
  },
  requiresApproval: () => true
}

export function registerVideoGenerationTool(): void {
  toolRegistry.register(videoGenerationHandler)
}

export function unregisterVideoGenerationTool(): void {
  toolRegistry.unregister(videoGenerationHandler.definition.name)
}

export function isVideoGenerationToolRegistered(): boolean {
  return toolRegistry.has(videoGenerationHandler.definition.name)
}
