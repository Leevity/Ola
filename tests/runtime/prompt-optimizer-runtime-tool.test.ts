import { describe, expect, it } from 'vitest'
import { createPromptOptimizerRuntimeTool } from '../../src/main/runtime/prompt-optimizer-runtime-tool'

const context = {
  run: {
    runId: 'optimizer-run',
    taskId: 'optimizer-task',
    requestId: 'optimizer-request',
    traceId: 'optimizer-trace',
    sessionId: 'optimizer-session',
    workspaceId: 'local-personal',
    environmentId: 'local',
    prompt: 'optimize',
    unattended: false,
    modelSource: { kind: 'local' as const, providerId: 'provider', modelId: 'model' }
  },
  signal: new AbortController().signal
}

describe('TS prompt optimizer tool', () => {
  it('returns bounded structured options without touching files', async () => {
    const tool = createPromptOptimizerRuntimeTool()
    const input = tool.validate({
      options: [{ title: 'Clear', focus: 'Specific', content: '# Objective\nDo the thing.' }]
    })
    expect(await tool.execute(input, context)).toEqual({
      __olaPromptOptimizationOptions: true,
      options: [{ title: 'Clear', focus: 'Specific', content: '# Objective\nDo the thing.' }]
    })
  })

  it('rejects more than three options', () => {
    const tool = createPromptOptimizerRuntimeTool()
    expect(() =>
      tool.validate({
        options: [1, 2, 3, 4].map((index) => ({ title: String(index), focus: 'x', content: 'y' }))
      })
    ).toThrow('INVALID_TOOL_INPUT')
  })
})
