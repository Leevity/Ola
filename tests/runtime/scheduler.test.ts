import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunJournal } from '../../src/runtime/storage/run-journal'
import { RunScheduler, type RunExecutor } from '../../src/runtime/scheduler/run-scheduler'
import { RuntimeError, type RunSpec } from '../../src/shared/runtime/contracts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
export const spec = (id: string, session = id): RunSpec => ({
  runId: id,
  taskId: id,
  requestId: id,
  traceId: id,
  workspaceId: 'local-personal',
  sessionId: session,
  environmentId: 'local',
  modelSource: { kind: 'local', providerId: 'lan', modelId: 'qwen' },
  prompt: 'hello',
  unattended: true
})
async function setup(
  execute: RunExecutor,
  authorize: (run: RunSpec) => Promise<void> = async () => undefined
) {
  const dir = await mkdtemp(join(tmpdir(), 'ola-runtime-test-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const journal = new RunJournal(join(dir, 'runs.db'))
  cleanup.push(() => journal.close())
  const scheduler = new RunScheduler(journal, execute, authorize)
  cleanup.push(() => scheduler.stop())
  await scheduler.initialize()
  return { journal, scheduler, dir }
}
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('durable scheduler', () => {
  it('does not let a persisted session ID acquire a second workspace owner', async () => {
    const { journal, scheduler } = await setup(async () => undefined)
    await scheduler.submit(spec('personal-run', 'shared-session'))
    await expect(
      scheduler.submit({ ...spec('team-run', 'shared-session'), workspaceId: 'team-a' })
    ).rejects.toThrow('SESSION_WORKSPACE_MISMATCH')
    expect(await journal.snapshot('team-run', 'team-a')).toBeNull()
  })

  it('cancels active and queued team runs on directory revocation without cancelling personal work', async () => {
    const entered: string[] = []
    const { journal, scheduler } = await setup(async (run, context) => {
      entered.push(run.runId)
      if (run.runId === 'active-team') {
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve()
          else context.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        context.signal.throwIfAborted()
      }
    })
    await scheduler.submit({ ...spec('active-team', 'same'), workspaceId: 'team-a' })
    await scheduler.submit({ ...spec('queued-team', 'same'), workspaceId: 'team-a' })
    await scheduler.submit(spec('personal'))
    await expect.poll(() => entered).toContain('active-team')
    scheduler.revokeUnavailableWorkspaces(new Set())
    await expect
      .poll(async () => (await journal.snapshot('active-team', 'team-a'))?.run.status)
      .toBe('cancelled')
    await expect
      .poll(async () => (await journal.snapshot('queued-team', 'team-a'))?.run.status)
      .toBe('cancelled')
    await expect
      .poll(async () => (await journal.snapshot('personal', 'local-personal'))?.run.status)
      .toBe('completed')
    expect(entered).not.toContain('queued-team')
  })
  it('rechecks authorization before a queued run executes', async () => {
    const release = gate()
    const entered: string[] = []
    let secondAuthorized = true
    const { journal, scheduler } = await setup(
      async (run) => {
        entered.push(run.runId)
        if (run.runId === 'first') await release.promise
      },
      async (run) => {
        if (run.runId === 'second' && !secondAuthorized)
          throw new RuntimeError('WORKSPACE_FORBIDDEN')
      }
    )
    await scheduler.submit(spec('first', 'same'))
    await scheduler.submit(spec('second', 'same'))
    await expect.poll(() => entered).toContain('first')
    secondAuthorized = false
    release.resolve()
    await expect
      .poll(async () => (await journal.snapshot('second', 'local-personal'))?.run.status)
      .toBe('failed')
    expect(entered).toEqual(['first'])
  })
  it('serializes a session, starts other sessions, replays after client detach and survives subscriber failure', async () => {
    const release = gate()
    const entered: string[] = []
    const { journal, scheduler } = await setup(async (run, context) => {
      entered.push(run.runId)
      await context.emit('message.delta', { text: run.runId })
      if (run.runId === 'a') await release.promise
    })
    scheduler.onEvent(() => {
      throw new Error('broken UI')
    })
    await scheduler.submit(spec('a', 'same'))
    await scheduler.submit(spec('b', 'same'))
    await scheduler.submit(spec('c', 'other'))
    await expect.poll(() => entered).toContain('c')
    expect(entered).not.toContain('b')
    release.resolve()
    await expect
      .poll(async () => (await journal.snapshot('b', 'local-personal'))?.run.status)
      .toBe('completed')
    const replay = await journal.snapshot('a', 'local-personal')
    expect(replay?.events.map((event) => event.seq)).toEqual([1, 2, 3, 4])
    expect(await journal.snapshot('a', 'another-team')).toBeNull()
  })
  it('deduplicates submission and prevents conflicting retries', async () => {
    let calls = 0
    const { journal, scheduler } = await setup(async () => {
      calls++
    })
    const input = {
      ...spec('a'),
      history: [
        { role: 'system' as const, text: 'Use concise answers.' },
        { role: 'user' as const, text: 'Earlier question' },
        { role: 'assistant' as const, text: 'Earlier answer' }
      ]
    }
    await Promise.all([scheduler.submit(input), scheduler.submit(input)])
    await expect
      .poll(async () => (await journal.snapshot('a', 'local-personal'))?.run.status)
      .toBe('completed')
    expect(calls).toBe(1)
    expect((await journal.list('local-personal'))[0]).not.toHaveProperty('prompt')
    expect((await journal.list('local-personal'))[0]).not.toHaveProperty('history')
    expect((await journal.list('local-personal'))[0]).not.toHaveProperty('modelOptions')
    expect((await journal.snapshot('a', 'local-personal'))?.run.history).toEqual(input.history)
    await expect(scheduler.submit({ ...spec('a'), prompt: 'different' })).rejects.toThrow(
      'REQUEST_CONFLICT'
    )
  })
  it('rejects malformed or oversized text history at the scheduler boundary', async () => {
    const { scheduler } = await setup(async () => undefined)
    await expect(
      scheduler.submit({ ...spec('malformed'), history: [{ role: 'tool', text: 'forbidden' }] })
    ).rejects.toThrow('INVALID_RUN')
    await expect(
      scheduler.submit({
        ...spec('oversized'),
        history: Array.from({ length: 129 }, () => ({ role: 'user', text: 'too many' }))
      })
    ).rejects.toThrow('INVALID_RUN')
  })
  it('cancels queued and active work without leaking ownership', async () => {
    const { journal, scheduler } = await setup(async (_run, { signal }) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
    })
    await scheduler.submit(spec('a', 'same'))
    await scheduler.submit(spec('b', 'same'))
    await expect(scheduler.switchWorkspace('team', new Set(['team']))).rejects.toThrow(
      'WORKSPACE_BUSY'
    )
    await expect(scheduler.cancel('a', 'team')).rejects.toThrow('RUN_NOT_FOUND')
    await scheduler.cancel('b', 'local-personal')
    await scheduler.cancel('a', 'local-personal')
    await expect
      .poll(async () => (await journal.snapshot('a', 'local-personal'))?.run.status)
      .toBe('cancelled')
    expect((await journal.snapshot('b', 'local-personal'))?.run.status).toBe('cancelled')
    await expect
      .poll(() =>
        scheduler.switchWorkspace('team', new Set(['team'])).then(
          () => true,
          () => false
        )
      )
      .toBe(true)
  })
  it('records interruption rather than repeating effects after restart', async () => {
    const { journal } = await setup(async () => undefined)
    await journal.create(spec('unfinished'))
    await journal.transition('unfinished', 'local-personal', ['queued'], 'running')
    await journal.append('unfinished', 'local-personal', 'tool.started', { effect: 'write' })
    await journal.recover()
    const snapshot = await journal.snapshot('unfinished', 'local-personal')
    expect(snapshot?.run.status).toBe('interrupted')
    expect(snapshot?.events.at(-1)?.data).toEqual({
      status: 'interrupted',
      reason: 'RUNTIME_RESTARTED_REVIEW_SIDE_EFFECTS'
    })
    expect(await journal.recover()).toEqual([])
  })
  it('persists an interaction, restores the running state after a response, and scopes it to its workspace', async () => {
    const received: unknown[] = []
    const { journal, scheduler } = await setup(async (_run, context) => {
      received.push(
        await context.requestInteraction({
          interactionId: 'approve-1',
          kind: 'tool-approval',
          payload: { tool: 'write_file' },
          version: 'plan-3'
        })
      )
      await context.emit('answer.applied', { ok: true })
    })
    await scheduler.submit({ ...spec('interactive'), unattended: false })
    await expect
      .poll(async () => (await journal.snapshot('interactive', 'local-personal'))?.run.status)
      .toBe('waiting_interaction')
    const waiting = await journal.snapshot('interactive', 'local-personal')
    expect(waiting?.pendingInteractions).toEqual([
      expect.objectContaining({
        interactionId: 'approve-1',
        kind: 'tool-approval',
        version: 'plan-3'
      })
    ])
    await expect(
      scheduler.respondInteraction('interactive', 'another-workspace', 'approve-1', {
        approved: true
      })
    ).rejects.toThrow('RUN_NOT_FOUND')
    await scheduler.respondInteraction('interactive', 'local-personal', 'approve-1', {
      approved: true
    })
    await expect
      .poll(async () => (await journal.snapshot('interactive', 'local-personal'))?.run.status)
      .toBe('completed')
    expect(received).toEqual([{ approved: true }])
    expect((await journal.snapshot('interactive', 'local-personal'))?.pendingInteractions).toEqual(
      []
    )
  })
  it('rejects a team approval after its offline authorization is revoked', async () => {
    const received: unknown[] = []
    let authorized = true
    const { journal, scheduler } = await setup(
      async (_run, context) => {
        received.push(
          await context.requestInteraction({
            interactionId: 'team-approval',
            kind: 'tool-approval',
            payload: { tool: 'write_file' }
          })
        )
      },
      async (run) => {
        if (run.workspaceId === 'team-a' && !authorized)
          throw new RuntimeError('WORKSPACE_FORBIDDEN')
      }
    )
    await scheduler.submit({
      ...spec('team-interactive'),
      workspaceId: 'team-a',
      unattended: false
    })
    await expect
      .poll(async () => (await journal.snapshot('team-interactive', 'team-a'))?.run.status)
      .toBe('waiting_interaction')
    authorized = false
    await expect(
      scheduler.respondInteraction('team-interactive', 'team-a', 'team-approval', {
        approved: true
      })
    ).rejects.toThrow('WORKSPACE_FORBIDDEN')
    expect(
      (await journal.snapshot('team-interactive', 'team-a'))?.pendingInteractions
    ).toHaveLength(1)
    expect(received).toEqual([])
    scheduler.revokeUnavailableWorkspaces(new Set())
    await expect
      .poll(async () => (await journal.snapshot('team-interactive', 'team-a'))?.run.status)
      .toBe('cancelled')
  })
  it('cannot apply approval when revocation aborts an in-flight authorization check', async () => {
    const checking = gate()
    const releaseCheck = gate()
    let pauseApprovalCheck = false
    const received: unknown[] = []
    const { journal, scheduler } = await setup(
      async (_run, context) => {
        received.push(
          await context.requestInteraction({
            interactionId: 'team-approval',
            kind: 'tool-approval',
            payload: { tool: 'write_file' }
          })
        )
      },
      async () => {
        if (!pauseApprovalCheck) return
        checking.resolve()
        await releaseCheck.promise
      }
    )
    await scheduler.submit({
      ...spec('team-approval-race'),
      workspaceId: 'team-a',
      unattended: false
    })
    await expect
      .poll(async () => (await journal.snapshot('team-approval-race', 'team-a'))?.run.status)
      .toBe('waiting_interaction')
    pauseApprovalCheck = true
    const pending = scheduler.respondInteraction('team-approval-race', 'team-a', 'team-approval', {
      approved: true
    })
    await checking.promise
    scheduler.revokeUnavailableWorkspaces(new Set())
    releaseCheck.resolve()
    await expect(pending).rejects.toThrow('WORKSPACE_FORBIDDEN')
    await expect
      .poll(async () => (await journal.snapshot('team-approval-race', 'team-a'))?.run.status)
      .toBe('cancelled')
    expect(received).toEqual([])
  })
  it('redacts secret-bearing interaction fields before persisting them for renderer replay', async () => {
    const { journal, scheduler } = await setup(async (_run, context) => {
      await context.requestInteraction({
        interactionId: 'redacted-approval',
        kind: 'tool-approval',
        payload: {
          id: 'write',
          name: 'write_text_file',
          input: { path: 'safe.txt', apiKey: 'must-not-persist' },
          authorization: 'Bearer must-not-persist'
        }
      })
    })
    await scheduler.submit({ ...spec('redacted-interaction'), unattended: false })
    await expect
      .poll(
        async () => (await journal.snapshot('redacted-interaction', 'local-personal'))?.run.status
      )
      .toBe('waiting_interaction')
    expect(
      (await journal.snapshot('redacted-interaction', 'local-personal'))?.pendingInteractions[0]
        ?.payload
    ).toEqual({
      id: 'write',
      name: 'write_text_file',
      input: { path: 'safe.txt', apiKey: '[REDACTED]' },
      authorization: '[REDACTED]'
    })
    await scheduler.cancel('redacted-interaction', 'local-personal')
  })
  it('fails unattended interactions and cancels a pending interactive run without leaving a waiter', async () => {
    const { journal, scheduler } = await setup(async (_run, context) => {
      await context.requestInteraction({
        interactionId: 'need-answer',
        kind: 'question',
        payload: {}
      })
    })
    await scheduler.submit(spec('unattended'))
    await expect
      .poll(async () => (await journal.snapshot('unattended', 'local-personal'))?.run.status)
      .toBe('failed')
    expect(
      (await journal.snapshot('unattended', 'local-personal'))?.events.at(-1)?.data
    ).toMatchObject({
      reason: 'UNATTENDED_INTERACTION_REQUIRED'
    })

    await scheduler.submit({ ...spec('cancel-interaction'), unattended: false })
    await expect
      .poll(
        async () => (await journal.snapshot('cancel-interaction', 'local-personal'))?.run.status
      )
      .toBe('waiting_interaction')
    await scheduler.cancel('cancel-interaction', 'local-personal')
    await expect
      .poll(
        async () => (await journal.snapshot('cancel-interaction', 'local-personal'))?.run.status
      )
      .toBe('cancelled')
    expect(
      (await journal.snapshot('cancel-interaction', 'local-personal'))?.pendingInteractions
    ).toEqual([])
    await expect(
      scheduler.respondInteraction('cancel-interaction', 'local-personal', 'need-answer', {})
    ).rejects.toThrow('INTERACTION_NOT_PENDING')
  })
})
