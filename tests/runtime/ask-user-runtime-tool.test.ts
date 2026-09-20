import { describe, expect, it } from 'vitest'
import { createAskUserRuntimeTool } from '../../src/main/runtime/ask-user-runtime-tool'
import type { ToolContext } from '../../src/runtime/tools/tool-executor'

const context: ToolContext = {
  run: {
    runId: 'run-a',
    taskId: 'task-a',
    requestId: 'request-a',
    traceId: 'trace-a',
    sessionId: 'session-a',
    workspaceId: 'workspace-a',
    environmentId: 'local',
    modelSource: { kind: 'local', providerId: 'provider', modelId: 'model' },
    prompt: 'test',
    unattended: false
  },
  signal: new AbortController().signal,
  requestInteraction: async (interaction) => ({ interaction, answers: { q1: 'yes' } })
}

describe('Main TS AskUserQuestion tool', () => {
  it('normalizes bounded questions and delegates to the interaction protocol', async () => {
    const tool = createAskUserRuntimeTool()
    const input = tool.validate({
      questions: [
        {
          question: 'Continue?',
          header: 'Confirm',
          options: [
            { label: 'Yes', description: 'Continue the operation' },
            { label: 'No', description: 'Stop the operation' }
          ]
        }
      ]
    })
    await expect(tool.execute(input, context)).resolves.toMatchObject({ answers: { q1: 'yes' } })
  })

  it('rejects malformed or unattended questions', async () => {
    const tool = createAskUserRuntimeTool()
    expect(() => tool.validate({ questions: [] })).toThrow('INVALID_TOOL_INPUT')
    await expect(
      tool.execute({ questions: [] }, { ...context, run: { ...context.run, unattended: true } })
    ).rejects.toThrow('QUESTION_INTERACTION_UNAVAILABLE')
  })
})
