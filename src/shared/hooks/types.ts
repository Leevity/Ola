export const HOOKS_SCHEMA_VERSION = 1 as const

export const HOOK_EVENTS = [
  'sessionStart',
  'userPromptSubmit',
  'preToolUse',
  'postToolUse',
  'permissionRequest',
  'preCompact',
  'postCompact',
  'stop'
] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]
export type HookSource = 'user' | 'project'
export type HookTrustState = 'pending' | 'trusted'

export interface HookCommandConfig {
  id: string
  event: HookEvent
  command: string
  args?: string[]
  artifacts?: string[]
  timeoutMs?: number
  enabled?: boolean
}

export interface HooksConfig {
  version: typeof HOOKS_SCHEMA_VERSION
  hooks: HookCommandConfig[]
}

export interface LoadedHook extends Required<Omit<HookCommandConfig, 'args' | 'artifacts'>> {
  args: string[]
  artifacts: string[]
  source: HookSource
  configPath: string
  configHash: string
  executablePath: string
  executableHash: string
  artifactHashes: Record<string, string>
  trustKey: string
  trustState: HookTrustState
}

export interface HookInvocation {
  version: typeof HOOKS_SCHEMA_VERSION
  event: HookEvent
  sessionId: string
  projectPath?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResult?: unknown
  prompt?: string
  cancellationKey?: string
}

export type HookPermissionDecision = 'allow' | 'deny' | 'ask'

export interface HookOutput {
  additionalContext?: string
  updatedPrompt?: string
  updatedInput?: Record<string, unknown>
  replacementToolFeedback?: string
  permissionDecision?: HookPermissionDecision
  block?: { reason: string }
}

export interface HookRunRecord {
  id: string
  hookId: string
  event: HookEvent
  source: HookSource
  startedAt: number
  durationMs: number
  exitCode: number | null
  status: 'completed' | 'failed' | 'blocked' | 'timed-out' | 'canceled'
  stdoutSummary: string
  stderrSummary: string
}
