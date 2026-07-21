import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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

interface HooksState {
  version: 1
  trustedKeys: string[]
  history: HookRunRecord[]
}

const MAX_HISTORY = 500
const HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000

export class HooksService {
  private state: HooksState = { version: 1, trustedKeys: [], history: [] }
  private initialized = false
  private writeQueue = Promise.resolve()
  readonly runner: HooksRunner

  constructor(
    private readonly statePath = join(homedir(), '.ola', 'hooks-state-v1.json'),
    maxConcurrency = 4
  ) {
    this.runner = new HooksRunner(maxConcurrency)
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
    const paths = hooksConfigPaths(homedir(), projectPath)
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
    const hooks = (await this.list(invocation.projectPath)).filter(
      (hook) => hook.enabled && hook.event === event && hook.trustState === 'trusted'
    )
    const outputs: HookOutput[] = []
    for (const hook of hooks) {
      const result = await this.runner.run(hook, { ...invocation, version: 1, event })
      this.state.history.push(result.record)
      this.pruneHistory()
      await this.persist()
      outputs.push(result.output)
      if (result.output.block || result.output.permissionDecision === 'deny') break
    }
    return outputs
  }
}

export const hooksService = new HooksService()
