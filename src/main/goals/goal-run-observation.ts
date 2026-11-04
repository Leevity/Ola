import type { RuntimeTokenUsage } from '../../shared/runtime/usage'

/** The only loop terminal reasons the goal tracker reacts to. */
export type GoalLoopEndReason = 'completed' | 'max_iterations' | 'aborted' | 'error'

/**
 * The narrow slice of loop events the goal tracker consumes: which tool calls
 * are open or failed, how many tokens a turn used, whether the provider rate
 * limited us, and how the loop ended.
 *
 * This is deliberately main-owned. Goal tracking must not depend on the
 * renderer's UI event vocabulary, and a narrower input keeps new UI event names
 * from silently changing goal accounting.
 */
export type GoalRunObservation =
  | { type: 'tool_use_streaming_start'; toolCallId: string; toolName: string }
  | { type: 'tool_use_generated'; toolUseBlock: { id: string; name: string } }
  | { type: 'tool_call_start'; toolCall: { id: string; name: string } }
  | { type: 'tool_call_result'; toolCall: { id: string; name: string; error?: string } }
  | { type: 'message_end'; usage?: RuntimeTokenUsage }
  | { type: 'error'; error: { message: string } }
  | { type: 'loop_end'; reason: GoalLoopEndReason }
