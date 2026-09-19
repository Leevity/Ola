import { toolRegistry } from '../agent/tool-registry'
import { encodeStructuredToolResult, encodeToolError } from './tool-result-format'
import type { ToolHandler } from './tool-types'

const visualizeShowWidgetHandler: ToolHandler = {
  definition: {
    name: 'visualize_show_widget',
    description:
      'Show visual content — SVG graphics, diagrams, charts, or interactive HTML widgets — that renders inline alongside your text response.\n' +
      'Use for flowcharts, architecture diagrams, dashboards, forms, calculators, data tables, games, illustrations, or any visual content.\n' +
      'The code is auto-detected: starts with <svg = SVG mode, otherwise HTML mode.\n' +
      'A global sendPrompt(text) function is available — it sends a message to chat as if the user typed it.\n' +
      'IMPORTANT: Call read_me before your first show_widget call.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description:
            'Short snake_case identifier for this visual. Must be specific and disambiguating.'
        },
        loading_messages: {
          type: 'array',
          description: '1-4 loading messages shown to the user while the visual renders.',
          minItems: 1,
          maxItems: 4,
          items: { type: 'string' }
        },
        widget_code: {
          type: 'string',
          description:
            'SVG or HTML code to render. For SVG: raw SVG code starting with <svg> tag. For HTML: raw HTML content without DOCTYPE, <html>, <head>, or <body> tags.'
        }
      },
      required: ['loading_messages', 'title', 'widget_code']
    }
  },
  execute: async (input) => {
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    const widgetCode = typeof input.widget_code === 'string' ? input.widget_code.trim() : ''
    const loadingMessages = Array.isArray(input.loading_messages)
      ? input.loading_messages.filter((value): value is string => typeof value === 'string')
      : []
    if (!title) return encodeToolError('title is required')
    if (!widgetCode) return encodeToolError('widget_code is required')
    if (loadingMessages.length === 0) return encodeToolError('loading_messages is required')
    if (widgetCode.length > 500_000) return encodeToolError('widget_code exceeds the 500KB limit')
    const kind = /^<svg[\s>]/i.test(widgetCode) ? 'svg' : 'html'
    return encodeStructuredToolResult({
      success: true,
      title,
      kind,
      loading_messages: loadingMessages.slice(0, 4),
      widget_code_chars: widgetCode.length
    })
  },
  requiresApproval: () => false
}

export function registerWidgetTools(): void {
  toolRegistry.register(visualizeShowWidgetHandler)
}
