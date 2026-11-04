import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HookEvent, HookOutput, HookRunRecord, LoadedHook } from '../../src/shared/hooks/types'
import type { HooksRunner } from '../../src/main/hooks/hooks-runner'
import { HooksService } from '../../src/main/hooks/hooks-service'

const hook = {
  id: 'policy',
  event: 'preToolUse' as HookEvent,
  command: 'policy.sh',
  args: [],
  artifacts: [],
  enabled: true,
  timeoutMs: 1000,
  source: 'user' as const,
  configPath: '/config/hooks.json',
  configHash: 'h',
  executablePath: '/bin/policy.sh',
  executableHash: 'h',
  artifactHashes: {},
  trustKey: 'trust-key',
  trustState: 'trusted' as const
} as LoadedHook

function record(status: HookRunRecord['status']): HookRunRecord {
  return {
    id: `run-${status}`,
    hookId: hook.id,
    event: 'preToolUse',
    source: 'user',
    startedAt: Date.now(),
    durationMs: 1,
    exitCode: status === 'completed' ? 0 : 1,
    status,
    stdoutSummary: '',
    stderrSummary: ''
  }
}

type Run = (hook: LoadedHook) => Promise<{ output: HookOutput; record: HookRunRecord }>

class StubService extends HooksService {
  constructor(run: Run, enabled = true) {
    super(
      join(tmpdir(), `ola-hooks-service-${Math.random().toString(36).slice(2)}.json`),
      4,
      enabled,
      { run, cancel: () => undefined } as unknown as HooksRunner
    )
  }

  override async list(): Promise<LoadedHook[]> {
    return [hook]
  }
}

const invocation = { sessionId: 'session-a', toolName: 'Write', toolInput: { path: 'a.txt' } }

describe('HooksService.emit', () => {
  it('returns nothing when the feature switch is off', async () => {
    const service = new StubService(
      async () => ({ output: {}, record: record('completed') }),
      false
    )
    await expect(service.emit('preToolUse', invocation)).resolves.toEqual([])
  })

  it('denies a veto-capable call when the hook timed out', async () => {
    const service = new StubService(async () => ({ output: {}, record: record('timed-out') }))
    await expect(service.emit('preToolUse', invocation)).resolves.toEqual([
      { permissionDecision: 'deny', block: { reason: 'HOOK_EXECUTION_FAILED: timed-out' } }
    ])
  })

  it('denies a veto-capable call when the hook crashed', async () => {
    const service = new StubService(async () => ({ output: {}, record: record('failed') }))
    const outputs = await service.emit('preToolUse', invocation)
    expect(outputs[0].permissionDecision).toBe('deny')
    expect(outputs[0].block?.reason).toContain('HOOK_EXECUTION_FAILED')
  })

  it('denies a veto-capable call when the runner itself throws', async () => {
    const service = new StubService(async () => {
      throw new Error('Hook concurrency limit reached')
    })
    const outputs = await service.emit('preToolUse', invocation)
    expect(outputs).toEqual([
      {
        permissionDecision: 'deny',
        block: { reason: 'HOOK_EXECUTION_FAILED: Hook concurrency limit reached' }
      }
    ])
  })

  it('drops a failed postToolUse instead of denying the completed call', async () => {
    const service = new StubService(async () => ({ output: {}, record: record('timed-out') }))
    await expect(service.emit('postToolUse', invocation)).resolves.toEqual([])
  })

  it('passes a real verdict through', async () => {
    const service = new StubService(async () => ({
      output: { block: { reason: 'policy' } },
      record: record('blocked')
    }))
    await expect(service.emit('preToolUse', invocation)).resolves.toEqual([
      { block: { reason: 'policy' } }
    ])
  })

  it('keeps failed runs in the activity history', async () => {
    const service = new StubService(async () => ({ output: {}, record: record('timed-out') }))
    await service.emit('preToolUse', invocation)
    const history = await service.history()
    expect(history[0]).toMatchObject({ hookId: 'policy', status: 'timed-out' })
  })
})
