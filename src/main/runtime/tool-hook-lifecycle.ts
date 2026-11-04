import type { HookEvent, HookInvocation, HookOutput } from '../../shared/hooks/types'
import { RuntimeError } from '../../shared/runtime/contracts'
import type { ToolDefinition } from '../../runtime/tools/tool-executor'

/**
 * A hook whose output can stop a tool call. Deny wins over every other field so
 * a hook cannot both rewrite and veto the same call.
 */
function deniedBy(outputs: readonly HookOutput[]): string | null {
  for (const output of outputs) {
    if (output.permissionDecision === 'deny') return output.block?.reason ?? 'HOOK_DENIED'
    if (output.block) return output.block.reason
  }
  return null
}

export interface ToolHookLifecycleOptions {
  sessionId: string
  projectPath?: string
  /** A scenario-policy session is exempt from hooks, matching `hooks:emit`. */
  isPolicySession: boolean
  emit: (event: HookEvent, invocation: HookInvocation) => Promise<HookOutput[]>
}

/** A hook veto is reported as the ordinary permission denial, not a new error. */
export class ToolHookDeniedError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'ToolHookDeniedError'
  }
}

function baseInvocation(
  options: ToolHookLifecycleOptions,
  event: HookEvent,
  toolName: string,
  input: unknown
): HookInvocation {
  return {
    version: 1,
    event,
    sessionId: options.sessionId,
    ...(options.projectPath ? { projectPath: options.projectPath } : {}),
    toolName,
    toolInput:
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : { value: input }
  }
}

/**
 * Structured tool results carry payloads the runtime reads back by key
 * (`__runtimeToolImage`, `__olaExtensionResult`, `__olaImageResult`). Rewriting
 * or wrapping them would break image passing and artifact extraction, so hooks
 * may only replace plain string output.
 */
function isStructuredOutput(output: unknown): boolean {
  return output !== null && typeof output === 'object'
}

/**
 * Wraps tool definitions with `preToolUse` / `postToolUse` policy hooks.
 *
 * Hooks run in Main because both the policy runner and the tool executor live
 * here; a renderer-side hook would let the constrained side police itself and
 * could not see the real execution result.
 */
export function withToolHooks(
  definitions: ToolDefinition[],
  options: ToolHookLifecycleOptions
): ToolDefinition[] {
  if (options.isPolicySession) return definitions
  // Rollback switch: the runtime members stay optional, so this only skips wiring.
  if (process.env.OLA_HOOKS_TOOL_EVENTS === '0') return definitions
  return definitions.map((definition) => ({
    ...definition,
    async prepare(input: unknown) {
      // A hook that times out or crashes fails open. It must never be able to
      // wedge the tool loop, and the hook history still records the failure.
      const outputs = await options
        .emit('preToolUse', baseInvocation(options, 'preToolUse', definition.name, input))
        .catch(() => [] as HookOutput[])
      const denial = deniedBy(outputs)
      if (denial) throw new ToolHookDeniedError(denial)
      let next = input
      for (const output of outputs) {
        if (output.updatedInput) next = output.updatedInput
      }
      // The rewrite is model-authored content, so it must satisfy the same
      // contract the original input did before it reaches authorization.
      try {
        return next === input ? next : definition.validate(next)
      } catch {
        throw new RuntimeError('INVALID_TOOL_INPUT')
      }
    },
    async after(input: unknown, output: unknown) {
      const outputs = await options
        .emit('postToolUse', {
          ...baseInvocation(options, 'postToolUse', definition.name, input),
          toolResult: output
        })
        .catch(() => [] as HookOutput[])
      if (!outputs.length) return output
      let next = output
      const appended: string[] = []
      for (const hookOutput of outputs) {
        if (hookOutput.replacementToolFeedback !== undefined && !isStructuredOutput(output))
          next = hookOutput.replacementToolFeedback
        if (hookOutput.additionalContext) appended.push(hookOutput.additionalContext)
      }
      if (!appended.length) return next
      const context = appended.join('\n\n')
      if (isStructuredOutput(next)) return next
      return `${typeof next === 'string' ? next : String(next)}\n\n${context}`
    }
  }))
}
