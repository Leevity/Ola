import type { TaskProfile } from '../../task-profile'

export type AgentCategory =
  | 'research'
  | 'document'
  | 'communication'
  | 'data'
  | 'browser'
  | 'coordination'
  | 'architecture'
  | 'development'
  | 'debugging'
  | 'quality'
  | 'security'
  | 'performance'
  | 'testing'
  | 'devops'
  | 'release'
  | 'project-intelligence'
  | 'automation'

export type AgentRiskLevel = 'read-only' | 'write' | 'external-action'
export type ProfileScope = TaskProfile | 'both'

export interface AgentProfileMeta {
  profiles: ProfileScope[]
  category: AgentCategory
  tags: string[]
  recommended: boolean
  requiresProject: boolean
  riskLevel: AgentRiskLevel
  supportsBackground: boolean
  runtimeOnly?: boolean
}

const CODE_NAMES = new Set([
  'api-designer',
  'architect-reviewer',
  'code-reviewer',
  'debugger',
  'frontend-developer',
  'fullstack-developer',
  'performance-engineer',
  'refactor-expert',
  'security-auditor',
  'test-automator',
  'devops-engineer',
  'release-engineer',
  'project-intelligence-analyst'
])

const WORK_NAMES = new Set([
  'copywriter',
  'meeting-summarizer',
  'data-analyst',
  'translator',
  'researcher',
  'document-producer',
  'browser-operator',
  'project-coordinator'
])

const CATEGORY_BY_NAME: Record<string, AgentCategory> = {
  'api-designer': 'architecture',
  'architect-reviewer': 'architecture',
  'code-reviewer': 'quality',
  copywriter: 'communication',
  'cron-agent': 'automation',
  'data-analyst': 'data',
  debugger: 'debugging',
  'frontend-developer': 'development',
  'fullstack-developer': 'development',
  'meeting-summarizer': 'document',
  'performance-engineer': 'performance',
  'refactor-expert': 'development',
  'security-auditor': 'security',
  'test-automator': 'testing',
  translator: 'communication',
  researcher: 'research',
  'document-producer': 'document',
  'browser-operator': 'browser',
  'project-coordinator': 'coordination',
  'devops-engineer': 'devops',
  'release-engineer': 'release',
  'project-intelligence-analyst': 'project-intelligence'
}

export function inferAgentProfileMeta(name: string, tools: string[] = []): AgentProfileMeta {
  const normalized = name.trim().toLowerCase()
  const profiles: ProfileScope[] = CODE_NAMES.has(normalized)
    ? ['code']
    : WORK_NAMES.has(normalized)
      ? ['work']
      : ['both']
  const category = CATEGORY_BY_NAME[normalized] ?? 'coordination'
  const runtimeOnly = normalized === 'cron-agent'
  const supportsBackground = runtimeOnly || tools.includes('Notify')
  const hasWriteTool = tools.some((tool) => ['Write', 'Edit', 'Bash', 'Shell'].includes(tool))

  return {
    profiles,
    category,
    tags: [category],
    recommended: !runtimeOnly,
    requiresProject: profiles.includes('code'),
    riskLevel: hasWriteTool ? 'write' : 'read-only',
    supportsBackground,
    runtimeOnly
  }
}

const CODE_COMMANDS = new Set([
  'commit',
  'init',
  'plan',
  'review',
  'security-review',
  'analyze-project',
  'wiki',
  'codegraph',
  'test',
  'build',
  'debug',
  'release-check',
  'devops'
])

const WORK_COMMANDS = new Set([
  'research',
  'summarize',
  'report',
  'meeting-followup',
  'translate',
  'organize'
])

export function inferCommandProfileMeta(name: string): AgentProfileMeta {
  const normalizedName = name.trim().toLowerCase().replace(/^\//, '')
  const inferred = inferAgentProfileMeta(normalizedName)

  if (CODE_COMMANDS.has(normalizedName)) {
    return {
      ...inferred,
      profiles: ['code'],
      category: normalizedName === 'security-review' ? 'security' : inferred.category,
      recommended: true,
      requiresProject: !['commit', 'plan', 'review', 'security-review'].includes(normalizedName),
      riskLevel: ['commit', 'init', 'build', 'test', 'devops'].includes(normalizedName)
        ? 'write'
        : inferred.riskLevel
    }
  }

  if (WORK_COMMANDS.has(normalizedName)) {
    return {
      ...inferred,
      profiles: ['work'],
      category: normalizedName === 'translate' ? 'communication' : inferred.category,
      recommended: true,
      requiresProject: false,
      riskLevel: 'read-only'
    }
  }

  if (normalizedName === 'agents') {
    return {
      ...inferred,
      profiles: ['both'],
      category: 'coordination',
      recommended: false,
      requiresProject: false,
      riskLevel: 'write'
    }
  }

  return inferred
}

export function normalizeAgentProfileMeta(
  meta: Partial<AgentProfileMeta> | undefined,
  name: string,
  tools: string[]
): AgentProfileMeta {
  const fallback = inferAgentProfileMeta(name, tools)
  return {
    profiles:
      Array.isArray(meta?.profiles) && meta.profiles.length > 0 ? meta.profiles : fallback.profiles,
    category: meta?.category ?? fallback.category,
    tags: Array.isArray(meta?.tags) ? meta.tags : fallback.tags,
    recommended: typeof meta?.recommended === 'boolean' ? meta.recommended : fallback.recommended,
    requiresProject:
      typeof meta?.requiresProject === 'boolean' ? meta.requiresProject : fallback.requiresProject,
    riskLevel: meta?.riskLevel ?? fallback.riskLevel,
    supportsBackground:
      typeof meta?.supportsBackground === 'boolean'
        ? meta.supportsBackground
        : fallback.supportsBackground,
    runtimeOnly: meta?.runtimeOnly ?? fallback.runtimeOnly
  }
}

export function profileMatches(meta: AgentProfileMeta, profile: TaskProfile): boolean {
  return meta.profiles.includes('both') || meta.profiles.includes(profile)
}

export function rankAgents<
  T extends { name: string; description: string; profileMeta: AgentProfileMeta }
>(agents: T[], profile: TaskProfile, projectAvailable: boolean, prompt = ''): T[] {
  const query = prompt.toLowerCase()
  return [...agents].sort((a, b) => {
    const score = (agent: T): number => {
      const meta = agent.profileMeta
      let value = 0
      if (profileMatches(meta, profile)) value += 50
      if (meta.recommended) value += 10
      if (meta.requiresProject && projectAvailable) value += 8
      if (meta.requiresProject && !projectAvailable) value -= 12
      for (const token of `${agent.name} ${agent.description}`.toLowerCase().split(/[-\s,./]+/)) {
        if (token.length > 2 && query.includes(token)) value += 2
      }
      return value
    }
    return score(b) - score(a) || a.name.localeCompare(b.name)
  })
}
