import type { HookEvent, HookOutput } from '../../../../shared/hooks/types'
import type { UnifiedMessage } from '../api/types'

export type CompactHookEmitter = (
  event: HookEvent,
  invocation: {
    sessionId: string
    projectPath?: string
    prompt?: string
    cancellationKey?: string
  }
) => Promise<HookOutput[]>

export interface CompactHookSubject {
  sessionId: string
  projectPath?: string
  trigger: 'auto' | 'manual'
}

export interface PreCompactDecision {
  /** Set when a hook vetoed this compaction; the value is the user-facing reason. */
  blocked: string | null
  /** Hook-supplied extra guidance for the summarizer. */
  focusPrompt?: string
}

/**
 * Only a compaction summary message carries `meta.compactSummary`, and that is
 * exactly the message `postCompact` is allowed to extend — a real user message
 * must never be rewritten by a hook.
 */
function isCompactSummaryMessage(message: UnifiedMessage): boolean {
  return message.role === 'user' && !!message.meta?.compactSummary
}

/**
 * `preCompact` runs before a compaction so policy can veto it or steer the
 * summary. A hook that cannot run (timeout, crash) must not block the user's
 * explicit action, so failures resolve as "not blocked".
 */
export async function runPreCompactHooks(
  emit: CompactHookEmitter,
  subject: CompactHookSubject,
  messages: readonly UnifiedMessage[]
): Promise<PreCompactDecision> {
  const outputs = await emit('preCompact', {
    sessionId: subject.sessionId,
    ...(subject.projectPath ? { projectPath: subject.projectPath } : {}),
    prompt: `compact:${subject.trigger}:${messages.length}`,
    cancellationKey: `${subject.sessionId}:preCompact`
  }).catch(() => [] as HookOutput[])
  const blocked = outputs.find((output) => output.block)?.block?.reason
  if (blocked) return { blocked }
  const focusPrompt = outputs
    .map((output) => output.additionalContext ?? '')
    .join('\n\n')
    .trim()
  return { blocked: null, ...(focusPrompt ? { focusPrompt } : {}) }
}

/**
 * `postCompact` may extend the stored summary. The summary is a real message the
 * next turn reads, so the extra context lands in its content rather than in a
 * side channel the model never sees.
 */
export async function runPostCompactHooks(
  emit: CompactHookEmitter,
  subject: CompactHookSubject,
  messages: UnifiedMessage[]
): Promise<UnifiedMessage[]> {
  const outputs = await emit('postCompact', {
    sessionId: subject.sessionId,
    ...(subject.projectPath ? { projectPath: subject.projectPath } : {}),
    prompt: `compact:${subject.trigger}:${messages.length}`,
    cancellationKey: `${subject.sessionId}:postCompact`
  }).catch(() => [] as HookOutput[])
  const context = outputs
    .map((output) => output.additionalContext ?? '')
    .join('\n\n')
    .trim()
  if (!context) return messages
  const summaryIndex = messages.findIndex((message) => isCompactSummaryMessage(message))
  if (summaryIndex < 0) return messages
  const summary = messages[summaryIndex]
  const next = [...messages]
  next[summaryIndex] = {
    ...summary,
    content:
      typeof summary.content === 'string'
        ? `${summary.content}\n\n${context}`
        : [...summary.content, { type: 'text' as const, text: `\n\n${context}` }]
  }
  return next
}
