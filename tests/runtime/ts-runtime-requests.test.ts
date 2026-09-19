import { describe, expect, it } from 'vitest'
import {
  parseRuntimeInteractionRequest,
  parseRuntimeRunLocator,
  parseRuntimeRunSnapshotLocator,
  parseRuntimeWorkspaceRequest,
  parseRuntimeWorkspaceSwitchRequest
} from '../../src/main/ipc/ts-runtime-requests'

describe('TS runtime IPC request parsing', () => {
  it('normalizes the exact request shapes accepted by the runtime service', () => {
    expect(parseRuntimeWorkspaceRequest({ workspaceId: ' local-personal ' })).toEqual({
      workspaceId: 'local-personal'
    })
    expect(
      parseRuntimeWorkspaceSwitchRequest({
        fromWorkspaceId: ' local-personal ',
        workspaceId: ' team-a '
      })
    ).toEqual({ fromWorkspaceId: 'local-personal', workspaceId: 'team-a' })
    expect(parseRuntimeRunLocator({ workspaceId: 'local-personal', runId: 'run-1' })).toEqual({
      workspaceId: 'local-personal',
      runId: 'run-1'
    })
    expect(
      parseRuntimeRunSnapshotLocator({ workspaceId: 'local-personal', runId: 'run-1', afterSeq: 3 })
    ).toEqual({ workspaceId: 'local-personal', runId: 'run-1', afterSeq: 3 })
  })

  it('requires an explicit source workspace for a switch', () => {
    expect(() => parseRuntimeWorkspaceSwitchRequest({ workspaceId: 'team-a' })).toThrow(
      'INVALID_REQUEST'
    )
    expect(() =>
      parseRuntimeWorkspaceSwitchRequest({
        fromWorkspaceId: 'local-personal',
        workspaceId: 'team-a',
        ignored: true
      })
    ).toThrow('INVALID_REQUEST')
  })

  it.each([
    [{ workspaceId: '' }],
    [{ workspaceId: 'local\u0000personal' }],
    [{ workspaceId: 'local-personal', ignored: true }],
    [{ workspaceId: 'local-personal', runId: '' }],
    [{ workspaceId: 'local-personal', runId: 'run', extra: true }]
  ])('rejects malformed or surplus fields', (input) => {
    expect(() => parseRuntimeRunLocator(input)).toThrow('INVALID_REQUEST')
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '0', undefined])(
    'requires a non-negative integral snapshot sequence: %s',
    (afterSeq) => {
      expect(() =>
        parseRuntimeRunSnapshotLocator({ workspaceId: 'local-personal', runId: 'run', afterSeq })
      ).toThrow('INVALID_REQUEST')
    }
  )

  it('accepts a bounded interaction response without loosening run identifiers', () => {
    expect(
      parseRuntimeInteractionRequest({
        workspaceId: 'local-personal',
        runId: 'run',
        interactionId: 'approval',
        response: { approved: true }
      })
    ).toEqual({
      workspaceId: 'local-personal',
      runId: 'run',
      interactionId: 'approval',
      response: { approved: true }
    })
  })

  it.each([
    { workspaceId: 'local-personal', runId: 'run', interactionId: 'approval' },
    { workspaceId: 'local-personal', runId: 'run', interactionId: '', response: true },
    {
      workspaceId: 'local-personal',
      runId: 'run',
      interactionId: 'approval',
      response: 'x'.repeat(256 * 1024 + 1)
    }
  ])('rejects malformed or oversized interaction input', (input) => {
    expect(() => parseRuntimeInteractionRequest(input)).toThrow('INVALID_REQUEST')
  })
})
