import { RuntimeError } from '../../shared/runtime/contracts'
import type { ToolDefinition } from '../../runtime/tools/tool-executor'

export function createWidgetRuntimeTool(): ToolDefinition {
  return {
    name: 'visualize_show_widget',
    description: 'Create an inline SVG or HTML visualization for the current response.',
    inputSchema: { type: 'object', required: ['title', 'loading_messages', 'widget_code'] },
    effect: 'write',
    validate: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new RuntimeError('INVALID_TOOL_INPUT')
      const input = value as Record<string, unknown>
      if (typeof input.title !== 'string' || !input.title.trim())
        throw new RuntimeError('INVALID_TOOL_INPUT')
      if (!Array.isArray(input.loading_messages) || input.loading_messages.length < 1)
        throw new RuntimeError('INVALID_TOOL_INPUT')
      if (
        typeof input.widget_code !== 'string' ||
        !input.widget_code.trim() ||
        input.widget_code.length > 500_000
      )
        throw new RuntimeError('INVALID_TOOL_INPUT')
      return {
        title: input.title.trim(),
        loading_messages: input.loading_messages
          .filter((item): item is string => typeof item === 'string')
          .slice(0, 4),
        widget_code: input.widget_code.trim(),
        kind: /^<svg[\s>]/i.test(input.widget_code.trim()) ? 'svg' : 'html'
      }
    },
    resources: async (_value, context) => [
      `widget:${context.run.workspaceId}:${context.run.sessionId}`
    ],
    execute: async (value) => ({ success: true, ...(value as Record<string, unknown>) })
  }
}
