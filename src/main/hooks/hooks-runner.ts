import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import {
  HOOKS_SCHEMA_VERSION,
  type HookInvocation,
  type HookOutput,
  type HookRunRecord,
  type LoadedHook
} from '../../shared/hooks/types'

const MAX_INPUT_BYTES = 256 * 1024
const MAX_OUTPUT_BYTES = 256 * 1024
const MAX_SUMMARY_CHARS = 4_000

function sanitizeOutput(value: unknown): HookOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const output: HookOutput = {}
  if (typeof raw.additionalContext === 'string') output.additionalContext = raw.additionalContext
  if (typeof raw.updatedPrompt === 'string') output.updatedPrompt = raw.updatedPrompt
  if (
    raw.updatedInput &&
    typeof raw.updatedInput === 'object' &&
    !Array.isArray(raw.updatedInput)
  ) {
    output.updatedInput = raw.updatedInput as Record<string, unknown>
  }
  if (typeof raw.replacementToolFeedback === 'string') {
    output.replacementToolFeedback = raw.replacementToolFeedback
  }
  if (
    raw.permissionDecision === 'allow' ||
    raw.permissionDecision === 'deny' ||
    raw.permissionDecision === 'ask'
  ) {
    output.permissionDecision = raw.permissionDecision
  }
  if (raw.block && typeof raw.block === 'object' && !Array.isArray(raw.block)) {
    const reason = (raw.block as Record<string, unknown>).reason
    if (typeof reason === 'string' && reason.trim()) output.block = { reason }
  }
  return output
}

export interface HookRunResult {
  output: HookOutput
  record: HookRunRecord
}

export class HooksRunner {
  private readonly active = new Map<string, Set<ChildProcessWithoutNullStreams>>()
  private running = 0

  constructor(private readonly maxConcurrency = 4) {}

  cancel(cancellationKey: string): void {
    for (const child of this.active.get(cancellationKey) ?? []) this.terminate(child)
  }

  private terminate(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode !== null || child.signalCode !== null) return
    const signalTree = (signal: NodeJS.Signals): void => {
      if (process.platform === 'win32') {
        if (child.pid) {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true
          })
          killer.unref()
        }
        return
      }
      if (!child.pid) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        child.kill(signal)
      }
    }
    signalTree('SIGTERM')
    const escalation = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) signalTree('SIGKILL')
    }, 1_000)
    escalation.unref()
  }

  async run(hook: LoadedHook, invocation: HookInvocation): Promise<HookRunResult> {
    if (hook.trustState !== 'trusted') throw new Error(`Hook ${hook.id} is not trusted`)
    if (this.running >= this.maxConcurrency) throw new Error('Hook concurrency limit reached')
    const input = Buffer.from(JSON.stringify({ ...invocation, version: HOOKS_SCHEMA_VERSION }))
    if (input.byteLength > MAX_INPUT_BYTES) throw new Error('Hook input exceeds size limit')

    const startedAt = Date.now()
    const record: HookRunRecord = {
      id: randomUUID(),
      hookId: hook.id,
      event: hook.event,
      source: hook.source,
      startedAt,
      durationMs: 0,
      exitCode: null,
      status: 'failed',
      stdoutSummary: '',
      stderrSummary: ''
    }
    this.running += 1
    return new Promise((resolve, reject) => {
      const child = spawn(hook.executablePath, hook.args, {
        cwd:
          hook.source === 'project' ? dirname(dirname(hook.configPath)) : dirname(hook.configPath),
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          LANG: process.env.LANG ?? 'C.UTF-8'
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true
      })
      const key = invocation.cancellationKey ?? invocation.sessionId
      const children = this.active.get(key) ?? new Set<ChildProcessWithoutNullStreams>()
      children.add(child)
      this.active.set(key, children)
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let overflow = false
      let timedOut = false
      let cleaned = false
      const cleanup = (): boolean => {
        if (cleaned) return false
        cleaned = true
        clearTimeout(timer)
        children.delete(child)
        if (!children.size) this.active.delete(key)
        this.running -= 1
        return true
      }
      const append = (current: Buffer, chunk: Buffer): Buffer => {
        if (current.byteLength + chunk.byteLength > MAX_OUTPUT_BYTES) {
          overflow = true
          this.terminate(child)
          return current
        }
        return Buffer.concat([current, chunk])
      }
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = append(stdout, chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = append(stderr, chunk)
      })
      const timer = setTimeout(() => {
        timedOut = true
        this.terminate(child)
      }, hook.timeoutMs)
      child.on('error', (error) => {
        if (cleanup()) reject(error)
      })
      child.on('close', (code, signal) => {
        if (!cleanup()) return
        record.durationMs = Date.now() - startedAt
        record.exitCode = code
        record.stdoutSummary = stdout.toString('utf8').slice(-MAX_SUMMARY_CHARS)
        record.stderrSummary = stderr.toString('utf8').slice(-MAX_SUMMARY_CHARS)
        record.status = timedOut
          ? 'timed-out'
          : overflow
            ? 'failed'
            : signal
              ? 'canceled'
              : code !== 0
                ? 'failed'
                : 'completed'
        if (record.status !== 'completed') {
          resolve({ output: {}, record })
          return
        }
        try {
          const output = sanitizeOutput(stdout.length ? JSON.parse(stdout.toString('utf8')) : {})
          if (output.block) record.status = 'blocked'
          resolve({
            output,
            record
          })
        } catch {
          record.status = 'failed'
          resolve({ output: {}, record })
        }
      })
      child.stdin.end(input)
    })
  }
}
