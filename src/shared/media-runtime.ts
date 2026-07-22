export const MEDIA_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const MEDIA_FILE_MAX_BYTES = 512 * 1024 * 1024
export type VideoTaskState = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
export interface VideoTask {
  id: string
  provider: 'seedance' | 'xai'
  state: VideoTaskState
  prompt: string
  estimatedCostUsd: number | null
  progress: number
  outputUrl?: string
  outputBytes?: number
  error?: string
  createdAt: number
  updatedAt: number
}
export interface MediaPluginSettings {
  seedanceEnabled: boolean
  xaiEnabled: boolean
}
