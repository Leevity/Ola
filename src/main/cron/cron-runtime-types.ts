import type { ModelSource } from '../../shared/runtime/model-source'

export interface AgentDefinition {
  name: string
  description: string
  allowedTools: string[]
  maxIterations: number
  model?: string
  temperature?: number
  systemPrompt: string
}

export interface CronAgentRunOptions {
  jobId: string
  name?: string
  sessionId?: string | null
  prompt: string
  agentId?: string | null
  model?: string | null
  modelSource?: ModelSource | null
  workspaceId?: string | null
  sourceProviderId?: string | null
  workingFolder?: string | null
  sshConnectionId?: string | null
  firedAt?: number
  deliveryMode?: string
  deliveryTarget?: string | null
  maxIterations?: number
  pluginId?: string | null
  pluginChatId?: string | null
  getScheduledState?: () => boolean
}
