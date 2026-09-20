import { RuntimeError } from '../../shared/runtime/contracts'
import type { ToolDefinition } from '../../runtime/tools/tool-executor'

const MAX_QUESTIONS = 4
const MAX_TEXT = 2048

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT)
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value.trim()
}

function validateQuestions(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUESTIONS)
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value.map((item) => {
    const question = record(item)
    const options = question.options
    if (!Array.isArray(options) || options.length < 2 || options.length > 8)
      throw new RuntimeError('INVALID_TOOL_INPUT')
    return {
      question: text(question.question),
      header: text(question.header),
      options: options.map((option) => {
        const value = record(option)
        return { label: text(value.label), description: text(value.description) }
      }),
      multiSelect: question.multiSelect === true
    }
  })
}

export function createAskUserRuntimeTool(): ToolDefinition {
  return {
    name: 'AskUserQuestion',
    description: 'Ask the user one or more bounded questions and wait for answers.',
    inputSchema: {
      type: 'object',
      properties: { questions: { type: 'array', minItems: 1, maxItems: MAX_QUESTIONS } },
      required: ['questions'],
      additionalProperties: false
    },
    effect: 'write',
    validate: (value) => {
      const input = record(value)
      return { questions: validateQuestions(input.questions) }
    },
    resources: async (_value, context) => [
      `question:${context.run.workspaceId}:${context.run.sessionId}`
    ],
    execute: async (value, context) => {
      if (context.run.unattended || !context.requestInteraction)
        throw new RuntimeError('QUESTION_INTERACTION_UNAVAILABLE')
      return await context.requestInteraction({
        interactionId: `question:${context.run.runId}`,
        kind: 'question',
        payload: value,
        version: '1'
      })
    }
  }
}
