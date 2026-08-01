export const MEDIA_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const MEDIA_FILE_MAX_BYTES = 512 * 1024 * 1024
export type VideoTaskState = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
export type VideoProviderId = 'seedance' | 'xai'
export interface VideoGenerationRequest {
  provider: VideoProviderId
  prompt: string
  model?: string
  firstFrameUrl?: string
  lastFrameUrl?: string
  aspectRatio?: string
  durationSeconds?: number
  resolution?: string
  parameters?: Record<string, string | number | boolean>
}
export interface VideoProviderCapability {
  provider: VideoProviderId
  enabled: boolean
  models: string[]
  supportsFirstFrame: boolean
  supportsLastFrame: boolean
  aspectRatios: string[]
  durationsSeconds: number[]
  resolutions: string[]
}
export interface VideoTask {
  id: string
  provider: VideoProviderId
  state: VideoTaskState
  prompt: string
  request?: VideoGenerationRequest
  estimatedCostUsd: number | null
  progress: number
  outputUrl?: string
  outputBytes?: number
  error?: string
  createdAt: number
  updatedAt: number
}
export interface MediaPluginSettings {
  videoGenerationEnabled: boolean
  seedanceEnabled: boolean
  xaiEnabled: boolean
}
