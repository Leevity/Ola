import { parseModelSource, type ModelSource } from '../../shared/runtime/model-source'
import { parseRunSpec, type RunSpec, type RuntimeTextMessage } from '../../shared/runtime/contracts'

export type LegacyTextMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type LegacyRunEligibility =
  | { eligible: true; prompt: string; history: RuntimeTextMessage[]; modelSource: ModelSource }
  | { eligible: false; reason: string }

/**
 * This is intentionally conservative. A request reaches the TS runtime only
 * when every retained field has an equivalent; callers must keep all other
 * requests on the legacy engine until their capabilities are migrated.
 */
export function assessLegacyRunEligibility(input: {
  messages: readonly LegacyTextMessage[]
  modelSource: unknown
  toolCount?: number
  hasAttachments?: boolean
  hasPlan?: boolean
  sshConnectionId?: string | null
}): LegacyRunEligibility {
  if (input.toolCount) return { eligible: false, reason: 'TOOLS_NOT_MIGRATED' }
  if (input.hasAttachments) return { eligible: false, reason: 'ATTACHMENTS_NOT_MIGRATED' }
  if (input.hasPlan) return { eligible: false, reason: 'PLAN_NOT_MIGRATED' }
  if (input.sshConnectionId) return { eligible: false, reason: 'SSH_NOT_MIGRATED' }
  let modelSource: ModelSource
  try {
    modelSource = parseModelSource(input.modelSource)
  } catch {
    return { eligible: false, reason: 'MODEL_SOURCE_NOT_MIGRATED' }
  }
  if (input.messages.length === 0) return { eligible: false, reason: 'EMPTY_MESSAGES' }
  const current = input.messages.at(-1)
  if (!current || current.role !== 'user' || !current.content.trim())
    return { eligible: false, reason: 'CURRENT_PROMPT_NOT_MIGRATED' }
  const history = input.messages.slice(0, -1)
  if (history.some((message) => !message.content.trim()))
    return { eligible: false, reason: 'EMPTY_HISTORY_MESSAGE' }
  return {
    eligible: true,
    prompt: current.content,
    history: history.map(({ role, content }) => ({ role, text: content })),
    modelSource
  }
}

export function projectEligibleLegacyRun(
  eligibility: Extract<LegacyRunEligibility, { eligible: true }>,
  identity: Pick<
    RunSpec,
    | 'runId'
    | 'taskId'
    | 'requestId'
    | 'traceId'
    | 'sessionId'
    | 'workspaceId'
    | 'environmentId'
    | 'unattended'
  >
): RunSpec {
  return parseRunSpec({
    ...identity,
    modelSource: eligibility.modelSource,
    prompt: eligibility.prompt,
    ...(eligibility.history.length ? { history: eligibility.history } : {})
  })
}
