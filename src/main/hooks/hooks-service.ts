import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { olaDataRoot } from '../lib/ola-data-root'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import type {
  HookEvent,
  HookInvocation,
  HookOutput,
  HookRunRecord,
  LoadedHook
} from '../../shared/hooks/types'
import { hooksConfigPaths, loadHooksConfig } from './hooks-loader'
import { HooksRunner } from './hooks-runner'

// Temporarily disabled while the automation hook workflow is being redesigned. This is the single
// switch: `withToolHooks` reads it through `HooksService.enabled`, so a disabled service never
// advertises a veto gate that cannot run.
const AUTOMATION_HOOKS_ENABLED = false

interface HooksState {
  version: 1
  trustedKeys: string[]
  history: HookRunRecord[]
}

const MAX_HISTORY = 500
const HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000
const HISTORY_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000

/** The one verdict a broken policy gate may produce: a denial that names the failure. */
function executionFailedOutput(reason: string): HookOutput {
  return { permissionDecision: 'deny', block: { reason: `HOOK_EXECUTION_FAILED: ${reason}` } }
}

export class HooksService {
  private state: HooksState = { version: 1, trustedKeys: [], history: [] }
  private initialized = false
  private writeQueue = Promise.resolve()
  readonly runner: HooksRunner

  constructor(
    private readonly statePath = join(olaDataRoot(), 'hooks-state-v1.json'),
    maxConcurrency = 4,
    /** Test seam: production reads the module flag; a test can exercise the failure matrix. */
    private readonly enabledFlag: boolean = AUTOMATION_HOOKS_ENABLED,
    runner: HooksRunner = new HooksRunner(maxConcurrency)
  ) {
    this.runner = runner
    const cleanupTimer = setInterval(() => {
      void this.cleanupHistory()
    }, HISTORY_CLEANUP_INTERVAL_MS)
    cleanupTimer.unref()
  }

  /** Whether policy hooks are active. Wrappers must not install a gate when this is false. */
  get enabled(): boolean {
    return this.enabledFlag
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<HooksState>
      if (parsed.version === 1) {
        this.state.trustedKeys = Array.isArray(parsed.trustedKeys)
          ? parsed.trustedKeys.filter((key): key is string => typeof key === 'string')
          : []
        this.state.history = Array.isArray(parsed.history) ? parsed.history.slice(-MAX_HISTORY) : []
      }
    } catch {
      // A missing or corrupt state file safely starts with no trusted hooks.
    }
    this.pruneHistory()
  }

  private pruneHistory(): void {
    const cutoff = Date.now() - HISTORY_TTL_MS
    this.state.history = this.state.history
      .filter((record) => record.startedAt >= cutoff)
      .slice(-MAX_HISTORY)
  }

  private async cleanupHistory(): Promise<void> {
    await this.initialize()
    const previousLength = this.state.history.length
    this.pruneHistory()
    if (this.state.history.length !== previousLength) await this.persist()
  }

  private async persist(): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
      const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`
      await writeFile(temporaryPath, JSON.stringify(this.state), { mode: 0o600 })
      await rename(temporaryPath, this.statePath)
    })
    this.writeQueue = operation.catch(() => {})
    await operation
  }

  async list(projectPath?: string): Promise<LoadedHook[]> {
    await this.initialize()
    if (projectPath && /^(ssh|sftp):\/\//i.test(projectPath)) return []
    const trusted = new Set(this.state.trustedKeys)
    const paths = hooksConfigPaths(homedir(), projectPath, olaDataRoot())
    const results = await Promise.all(
      paths.map(async (path, index) => {
        try {
          return await loadHooksConfig(path, index === 0 ? 'user' : 'project', trusted)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT') return []
          throw error
        }
      })
    )
    return results.flat()
  }

  async trust(trustKey: string, projectPath?: string): Promise<void> {
    const hook = (await this.list(projectPath)).find((candidate) => candidate.trustKey === trustKey)
    if (!hook) throw new Error('Hook trust key is stale or unknown')
    if (!this.state.trustedKeys.includes(trustKey)) this.state.trustedKeys.push(trustKey)
    await this.persist()
  }

  async revoke(trustKey: string): Promise<void> {
    await this.initialize()
    this.state.trustedKeys = this.state.trustedKeys.filter((key) => key !== trustKey)
    await this.persist()
  }

  async history(): Promise<HookRunRecord[]> {
    await this.initialize()
    return [...this.state.history].reverse()
  }

  cancel(key: string): void {
    this.runner.cancel(key)
  }

  async emit(
    event: HookEvent,
    invocation: Omit<HookInvocation, 'event' | 'version'>
  ): Promise<HookOutput[]> {
    if (!this.enabled) return []
    const hooks = (await this.list(invocation.projectPath)).filter(
      (hook) => hook.enabled && hook.event === event && hook.trustState === 'trusted'
    )
    // Only `preToolUse` can veto. A failure on any other event loses an annotation, so it must
    // not turn into a denial.
    const vetoCapable = event === 'preToolUse'
    const outputs: HookOutput[] = []
    for (const hook of hooks) {
      let result: Awaited<ReturnType<HooksRunner['run']>>
      try {
        result = await this.runner.run(hook, { ...invocation, version: 1, event })
      } catch (error) {
        // The gate could not be evaluated at all (untrusted executable, size limit, saturated
        // runner). Denying this one call keeps the failure visible instead of silently allowing
        // an unvetted tool call.
        if (!vetoCapable) continue
        outputs.push(executionFailedOutput(error instanceof Error ? error.message : String(error)))
        break
      }
      this.state.history.push(result.record)
      this.pruneHistory()
      await this.persist()
      // A hook that timed out, crashed or printed unparsable output produced no verdict. "No
      // verdict" is not an approval: for a veto-capable event it must deny, otherwise a broken
      // hook silently authorizes every tool call it was meant to police.
      if (result.record.status !== 'completed' && result.record.status !== 'blocked') {
        if (!vetoCapable) continue
        outputs.push(executionFailedOutput(result.record.status))
        break
      }
      outputs.push(result.output)
      if (result.output.block || result.output.permissionDecision === 'deny') break
    }
    return outputs
  }
}

export const hooksService = new HooksService()
