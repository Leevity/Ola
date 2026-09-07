import type { AppMode } from '@renderer/stores/ui-store'
import type { SessionMode } from '@renderer/stores/chat-store'

export type TaskProfile = 'work' | 'code'

export interface TaskProfileConfig {
  profile: TaskProfile
  defaultSessionMode: Extract<SessionMode, 'chat' | 'execute'>
  mainProviderId?: string | null
  mainModelId?: string | null
  fastProviderId?: string | null
  fastModelId?: string | null
  promptPreset: 'work' | 'code'
  resultStyle: 'work' | 'code'
  preferredCapabilities: string[]
  enabledCapabilities: string[]
  projectContext: 'optional' | 'preferred'
  autoIndex: boolean
  allowShell: boolean
  preferWebSearch: boolean
  preferBrowser: boolean
  autoSummarize: boolean
  shellType?: 'default' | 'powershell' | 'bash'
  gitPolicy?: 'inspect-only' | 'ask-before-write' | 'allow-with-approval'
  verificationPolicy?: 'none' | 'lint-and-typecheck' | 'tests-and-build'
  diffStyle?: 'inline' | 'side-panel'
  fileApprovalPolicy?: 'always-ask' | 'ask-on-risk' | 'use-global'
  useTeams?: boolean
}

export const DEFAULT_WORK_PROFILE: TaskProfileConfig = {
  profile: 'work',
  defaultSessionMode: 'chat',
  promptPreset: 'work',
  resultStyle: 'work',
  preferredCapabilities: ['web-search', 'browser', 'documents', 'channels', 'automation'],
  enabledCapabilities: ['read', 'web-search', 'browser', 'documents', 'channels', 'automation'],
  projectContext: 'optional',
  autoIndex: false,
  allowShell: false,
  preferWebSearch: true,
  preferBrowser: true,
  autoSummarize: true,
  shellType: 'default',
  gitPolicy: 'inspect-only',
  verificationPolicy: 'lint-and-typecheck',
  diffStyle: 'side-panel',
  fileApprovalPolicy: 'use-global',
  useTeams: false
}

export const DEFAULT_CODE_PROFILE: TaskProfileConfig = {
  profile: 'code',
  defaultSessionMode: 'chat',
  promptPreset: 'code',
  resultStyle: 'code',
  preferredCapabilities: ['files', 'shell', 'git', 'codegraph', 'wiki', 'diff', 'tests'],
  enabledCapabilities: ['read', 'files', 'shell', 'git', 'codegraph', 'wiki', 'diff', 'tests'],
  projectContext: 'preferred',
  autoIndex: true,
  allowShell: true,
  preferWebSearch: false,
  preferBrowser: false,
  autoSummarize: true,
  shellType: 'default',
  gitPolicy: 'ask-before-write',
  verificationPolicy: 'tests-and-build',
  diffStyle: 'side-panel',
  fileApprovalPolicy: 'ask-on-risk',
  useTeams: true
}

export function normalizeTaskProfile(value: unknown): TaskProfile {
  return value === 'code' ? 'code' : 'work'
}

export function inferTaskProfile(mode: unknown, projectId?: string | null, workingFolder?: string | null): TaskProfile {
  if (mode === 'code' || mode === 'cowork') return 'code'
  if (mode === 'execute' && (projectId || workingFolder)) return 'code'
  return 'work'
}

export function profileConfigFor(
  profile: TaskProfile,
  workProfileConfig?: Partial<TaskProfileConfig>,
  codeProfileConfig?: Partial<TaskProfileConfig>
): TaskProfileConfig {
  const defaults = profile === 'code' ? DEFAULT_CODE_PROFILE : DEFAULT_WORK_PROFILE
  const override = profile === 'code' ? codeProfileConfig : workProfileConfig
  return {
    ...defaults,
    ...override,
    profile
  }
}

export function profileForAppMode(mode: AppMode): TaskProfile {
  return mode === 'execute' || mode === 'acp' ? 'code' : 'work'
}
