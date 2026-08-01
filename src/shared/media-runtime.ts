export const MEDIA_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const MEDIA_FILE_MAX_BYTES = 512 * 1024 * 1024
export type VideoTaskState = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
export type VideoProviderKind = 'seedance'
export interface VideoGenerationRequest {
  provider: VideoProviderKind
  providerId: string
  prompt: string
  model: string
  firstFrameUrl?: string
  lastFrameUrl?: string
  aspectRatio?: string
  durationSeconds?: number
  resolution?: string
  parameters?: Record<string, string | number | boolean>
}
export interface VideoProviderCapability {
  provider: VideoProviderKind
  providerId: string
  providerName: string
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
  provider: VideoProviderKind
  providerId: string
  model: string
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
}
