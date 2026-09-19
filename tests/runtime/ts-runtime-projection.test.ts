import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../../src/shared/runtime/contracts'
import {
  createTsRuntimeProjectionState,
  isTerminalTsRuntimeStatus,
  projectTsRuntimeInteraction,
  projectTsRuntimeEvents
} from '../../src/renderer/src/lib/ipc/ts-runtime-projection'

const event = (type: string, data: unknown): RunEvent => ({
  runId: 'run',
  workspaceId: 'local-personal',
  traceId: 'trace',
  seq: 1,
  type,
  data,
  timestamp: 1
})

describe('TS runtime renderer event projection', () => {
  it('projects persisted text, reasoning, and final usage without provider secrets', () => {
    expect(
      projectTsRuntimeEvents([
        event('run.status', { status: 'running' }),
        event('thinking.delta', { text: 'reasoning' }),
        event('message.delta', { text: 'answer' }),
        event('message.completed', {
          usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1, apiKey: 'never' }
        })
      ])
    ).toEqual([
      { type: 'message_start' },
      { type: 'thinking_delta', thinking: 'reasoning' },
      { type: 'text_delta', text: 'answer' },
      {
        type: 'message_end',
        usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 1 }
      }
    ])
  })

  it('turns failed terminal states into an actionable provider error', () => {
    expect(
      projectTsRuntimeEvents([
        event('run.status', { status: 'failed', reason: 'MODEL_UNAVAILABLE' })
      ])
    ).toEqual([
      {
        type: 'error',
        error: { type: 'MODEL_UNAVAILABLE', message: 'TS runtime execution failed.' }
      }
    ])
    expect(isTerminalTsRuntimeStatus('completed')).toBe(true)
    expect(isTerminalTsRuntimeStatus('running')).toBe(false)
  })

  it('turns a completed scheduler run into the existing successful loop terminal event', () => {
    expect(projectTsRuntimeEvents([event('run.status', { status: 'completed' })])).toEqual([
      { type: 'loop_end', reason: 'completed' }
    ])
  })

  it('does not report an externally cancelled run as completed', () => {
    expect(projectTsRuntimeEvents([event('run.status', { status: 'cancelled' })])).toEqual([
      {
        type: 'error',
        error: { type: 'RUN_CANCELLED', message: 'TS runtime execution was cancelled.' }
      }
    ])
  })

  it('projects persisted tool execution into the existing tool-card events', () => {
    expect(
      projectTsRuntimeEvents([
        event('tool.generated', {
          id: 'call',
          name: 'read_text_file',
          input: { path: 'safe.txt' }
        }),
        event('tool.result', {
          id: 'call',
          name: 'read_text_file',
          output: 'safe',
          isError: false
        })
      ])
    ).toEqual([
      {
        type: 'tool_use_generated',
        toolUseBlock: { id: 'call', name: 'read_text_file', input: { path: 'safe.txt' } }
      },
      {
        type: 'tool_call_result',
        toolCall: {
          id: 'call',
          name: 'read_text_file',
          input: { path: 'safe.txt' },
          status: 'completed',
          output: 'safe',
          requiresApproval: false,
          completedAt: 1
        }
      }
    ])
  })

  it('keeps tool input when a result arrives in a later runtime snapshot', () => {
    const state = createTsRuntimeProjectionState()
    expect(
      projectTsRuntimeEvents(
        [event('tool.generated', { id: 'call', name: 'web_search', input: { query: 'Ola' } })],
        state
      )
    ).toHaveLength(1)
    expect(
      projectTsRuntimeEvents(
        [event('tool.result', { id: 'call', name: 'web_search', output: { results: [] } })],
        state
      )
    ).toEqual([
      {
        type: 'tool_call_result',
        toolCall: {
          id: 'call',
          name: 'web_search',
          input: { query: 'Ola' },
          status: 'completed',
          output: '{"results":[]}',
          requiresApproval: false,
          completedAt: 1
        }
      }
    ])
  })

  it('keeps persisted interaction identity for a scoped renderer response', () => {
    expect(
      projectTsRuntimeInteraction({
        runId: 'run',
        workspaceId: 'local-personal',
        interactionId: 'approve-write',
        kind: 'tool-approval',
        payload: { id: 'tool-call', name: 'write_text_file', input: { path: 'safe.txt' } },
        version: '1',
        createdAt: 1
      })
    ).toEqual({
      type: 'runtime_interaction_requested',
      interaction: {
        runId: 'run',
        workspaceId: 'local-personal',
        interactionId: 'approve-write',
        kind: 'tool-approval',
        payload: { id: 'tool-call', name: 'write_text_file', input: { path: 'safe.txt' } },
        version: '1',
        createdAt: 1
      }
    })
  })
})
