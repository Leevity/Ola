import { RuntimeError } from '../../shared/runtime/contracts'
import type { ToolDefinition } from '../../runtime/tools/tool-executor'

const MAX_OPTIONS = 3
const MAX_FIELD = 32 * 1024

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value as Record<string, unknown>
}

function field(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_FIELD)
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value.trim()
}

function validate(value: unknown): {
  options: Array<{ title: string; focus: string; content: string }>
} {
  const input = record(value)
  if (Object.keys(input).length !== 1 || !Array.isArray(input.options))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  if (input.options.length < 1 || input.options.length > MAX_OPTIONS)
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return {
    options: input.options.map((item) => {
      const option = record(item)
      if (Object.keys(option).some((key) => !['title', 'focus', 'content'].includes(key)))
        throw new RuntimeError('INVALID_TOOL_INPUT')
      return {
        title: field(option.title),
        focus: field(option.focus),
        content: field(option.content)
      }
    })
  }
}

/** Main-owned structured output sink for the Prompt Optimizer. */
export function createPromptOptimizerRuntimeTool(): ToolDefinition {
  return {
    name: 'WriteOptimizedPrompts',
    description: 'Write one to three optimized prompt options with distinct focuses.',
    inputSchema: {
      type: 'object',
      properties: {
        options: { type: 'array', minItems: 1, maxItems: MAX_OPTIONS }
      },
      required: ['options'],
      additionalProperties: false
    },
    effect: 'write',
    validate,
    resources: async (_value, context) => [`prompt-optimizer:${context.run.runId}`],
    execute: async (value) => ({
      __olaPromptOptimizationOptions: true,
      options: (value as ReturnType<typeof validate>).options
    })
  }
}
