import { join } from 'node:path'
import { olaDataRoot } from '../lib/ola-data-root'
import { getBundledResourceDirCandidates } from '../resources/bundled-resources'
import { AgentCatalog } from '../user-content/agent-catalog'
import type { AgentDefinition } from './cron-runtime-types'

const FALLBACK_CRON_AGENT: AgentDefinition = {
  name: 'CronAgent',
  description: 'Scheduled task agent for cron jobs',
  allowedTools: [
    'Read',
    'Write',
    'Edit',
    'LS',
    'Glob',
    'Grep',
    'Bash',
    'Notify',
    'PluginSendMessage',
    'PluginReplyMessage',
    'SubmitReport'
  ],
  maxIterations: 15,
  systemPrompt:
    'You are CronAgent, a scheduled task assistant. You execute tasks autonomously on a timer. ' +
    'Be concise and action-oriented. Complete the task, then deliver results as instructed.'
}

const SUPPORTED_BACKGROUND_TOOLS = new Set(FALLBACK_CRON_AGENT.allowedTools)

export async function resolveCronAgentDefinition(
  agentId?: string | null
): Promise<AgentDefinition> {
  if (!agentId || agentId === FALLBACK_CRON_AGENT.name) return FALLBACK_CRON_AGENT
  try {
    const catalog = new AgentCatalog({
      userDirectory: join(olaDataRoot(), 'agents'),
      bundledDirectoryCandidates: getBundledResourceDirCandidates('agents')
    })
    const agent = await catalog.load(agentId)
    if ('error' in agent) {
      console.warn('[CronAgent] Agent load failed:', agent.error)
      return FALLBACK_CRON_AGENT
    }
    const sourceTools =
      agent.allowedTools.length > 0
        ? agent.allowedTools
        : Array.isArray(agent.tools)
          ? agent.tools
          : []
    const maxIterations =
      agent.maxIterations > 0
        ? agent.maxIterations
        : (agent.maxTurns ?? 0) > 0
          ? agent.maxTurns!
          : FALLBACK_CRON_AGENT.maxIterations
    return {
      name: agent.name,
      description: agent.description,
      allowedTools: sourceTools.filter((toolName) => SUPPORTED_BACKGROUND_TOOLS.has(toolName)),
      maxIterations,
      model: agent.model,
      temperature: agent.temperature,
      systemPrompt: agent.systemPrompt
    }
  } catch (error) {
    console.warn('[CronAgent] Failed to load custom agent definition:', error)
    return FALLBACK_CRON_AGENT
  }
}
