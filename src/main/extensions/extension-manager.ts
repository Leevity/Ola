/**
 * ExtensionManager — the lifecycle + capability-gate choke point for the extension system.
 *
 * Two responsibilities, split by the "policy vs mechanism" principle:
 *  - Lifecycle policy (who may activate, when to hibernate, which call is admitted) lives here;
 *    the isolated-context mechanism, manifest parsing and storage live in the services below.
 *  - The four gates below answer "may this call run at all"; the per-call tool whitelist in
 *    permission-policy.ts still runs at the tool-execution layer on top of that. Both must pass.
 *
 * An extension that cannot be gated must degrade to a diagnostic, never throw into the caller,
 * so one broken extension cannot take down the system or the app.
 */

import {
  capabilityEscalated,
  capabilityFingerprint,
  hasCapability,
  projectedCapabilities
} from '../../shared/extension-capabilities'
import type { ExtensionCapabilityKind } from '../../shared/extension-types'
import { ExtensionStateStore, type ExtensionState } from './extension-state-store'
import { ExtensionService, type RuntimeExtension } from './extension-service'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

const PATH_KEYS = new Set(['path', 'workspacePath', 'directory', 'file', 'glob'])
function isPathKey(key: string): boolean {
  return PATH_KEYS.has(key)
}

/**
 * Whether a path value stays lexically inside at least one declared prefix scope (`docs/*`,
 * `src/**`). Absolute or `..`-escaping paths are rejected at this layer; realpath normalization
 * happens at the executor. `root` is the workspace root resolved by the caller.
 */
function matchesPathScope(scopes: readonly string[], value: string, root: string): boolean {
  if (root && value.includes('\0')) return false
  if (!root) {
    // Without a resolved root, only relative, non-escaping values pass.
    if (value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return false
  }
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized || normalized.split('/').includes('..')) return false
  return scopes.some((scope) => {
    const prefix = scope.replace(/\\/g, '/').replace(/\*+$/, '').replace(/\/$/, '')
    if (!prefix) return false
    return normalized === prefix || normalized.startsWith(prefix + '/')
  })
}

/** Lifecycle states of a JS/declarative extension. */
export type ExtensionLifecycleState =
  | 'idle' // 已启用未激活（懒激活的休息态）
  | 'activating' // 正在激活
  | 'active' // 已激活且最近被使用
  | 'asleep' // 空闲休眠（内存已回收/工具已卸载）
  | 'disabled' // 用户禁用
  | 'error' // 激活/调用失败
  | 'pending-approval' // 升级扩权，待用户重新批准

export type ExtensionCallResult =
  | { decision: 'allow'; run: () => Promise<unknown> }
  | { decision: 'deny'; reason: DenyReason }

type CallEvaluation =
  | {
      decision: 'allow'
      id: string
      runtime: RuntimeExtension
      narrowed: { toolName: string; input: Record<string, unknown> }
    }
  | { decision: 'deny'; reason: DenyReason }

export type DenyReason =
  | 'unknown_method'
  | 'not-declared'
  | 'not-granted'
  | 'pending-approval'
  | 'disabled'
  | 'unsafe-param'

/** Methods the manager knows how to dispatch. Anything else is rejected at gate 1. */
export const MANAGER_METHODS = ['http.request'] as const
export type ManagerMethod = (typeof MANAGER_METHODS)[number]

export interface ExtensionManagerOptions {
  /** Seconds of inactivity after which an active extension is put to sleep. */
  idleTimeoutMs?: number
  /** How often the idle sweep runs. */
  sweepIntervalMs?: number
  /** Called when a denied call should be recorded in the activity log. */
  onDenied?: (extensionId: string, reason: DenyReason, detail: string) => void
}

export class ExtensionManager {
  private readonly lifecycle = new Map<string, ExtensionLifecycleState>()
  private readonly touchedAt = new Map<string, number>()
  /** Manifest fingerprint the current lifecycle state was established against. */
  private readonly lifecycleFingerprint = new Map<string, string>()
  private sweepTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly service: ExtensionService,
    private readonly stateStore: ExtensionStateStore,
    private readonly options: ExtensionManagerOptions = {},
    /**
     * Durable approval history, stored separately from the per-install state. Removing and
     * re-installing an extension deletes its state but must not reset what the user last
     * approved — otherwise an upgrade could silently widen its permission surface.
     *
     * Deliberately has no default: defaulting to `stateStore` would silently restore the
     * "remove resets the baseline" behaviour for any caller that forgets this argument.
     */
    private readonly approvalStore: ExtensionStateStore
  ) {}

  /** Declared upper bound after legacy `permissions.network` projection. */
  private declaredBound(runtime: RuntimeExtension): ExtensionCapabilityKind[] {
    const declaration = projectedCapabilities(runtime.manifest).declaration
    if (!declaration) return []
    return [...new Set([...declaration.required, ...(declaration.optional ?? [])])]
  }

  /** Required capabilities after legacy projection (not the raw on-disk manifest). */
  private requiredBound(runtime: RuntimeExtension): ExtensionCapabilityKind[] {
    return [...new Set(projectedCapabilities(runtime.manifest).declaration?.required ?? [])]
  }

  /** Resolve the effective capability state, applying the legacy fallback. */
  private async capabilityState(
    extensionId: string,
    runtime: RuntimeExtension,
    state: ExtensionState
  ): Promise<{ granted: ExtensionCapabilityKind[]; approvedRequired: ExtensionCapabilityKind[] }> {
    const required = this.requiredBound(runtime)
    // Legacy state has no granted/approvedRequired. Grant only what the extension requires —
    // optional capabilities must always be granted explicitly, never by a fallback.
    const granted = state.granted ?? [...required]
    const approvedRequired = state.approvedRequired ?? [...required]
    if (!state.granted || !state.approvedRequired) {
      await this.persistCapabilities(extensionId, granted, approvedRequired)
    }
    return { granted, approvedRequired }
  }

  private async persistCapabilities(
    extensionId: string,
    granted: ExtensionCapabilityKind[],
    approvedRequired: ExtensionCapabilityKind[]
  ): Promise<void> {
    await this.stateStore.update(extensionId, { granted, approvedRequired })
  }

  /**
   * The four-gate admission check without executing anything. Both the IPC handler and the
   * agent-runtime tool executor must call this so there is exactly one controlled entry point;
   * an executor that skips it would bypass declared/granted/approval gates entirely.
   */
  async admitCall(
    extensionId: unknown,
    method: string,
    params: unknown
  ): Promise<{ decision: 'allow' } | { decision: 'deny'; reason: DenyReason }> {
    const evaluated = await this.evaluateCall(extensionId, method, params)
    return evaluated.decision === 'allow'
      ? { decision: 'allow' }
      : { decision: 'deny', reason: evaluated.reason }
  }

  private async evaluateCall(
    extensionId: unknown,
    method: string,
    params: unknown
  ): Promise<CallEvaluation> {
    const id = typeof extensionId === 'string' ? extensionId : ''
    if (!id) return this.deny(id, 'unknown_method', 'missing extension id')
    // Gate 1: method must be one we implement.
    if (!(MANAGER_METHODS as readonly string[]).includes(method)) {
      return this.deny(id, 'unknown_method', `unknown method ${method}`)
    }
    let runtime: RuntimeExtension
    let state: ExtensionState
    try {
      runtime = await this.service.getRuntime(id)
      state = await this.stateStore.getOrCreate(id)
    } catch {
      return this.deny(id, 'unknown_method', `extension not found`)
    }
    if (!runtime.enabled) return this.deny(id, 'disabled', 'extension is disabled')
    const lifecycleState = await this.lifecycleFor(id, runtime, state)
    if (lifecycleState === 'pending-approval')
      return this.deny(id, 'pending-approval', 'upgrade awaiting approval')
    if (lifecycleState === 'disabled' || lifecycleState === 'error')
      return this.deny(id, 'disabled', 'extension cannot run')

    const { granted } = await this.capabilityState(id, runtime, state)
    const capability =
      method === 'http.request' ? ('network.request' as const) : ('agent.tool' as const)

    // Gate 2: the capability must be declared in required ∪ optional (after legacy projection).
    if (!this.declaredBound(runtime).includes(capability)) {
      return this.deny(id, 'not-declared', `${capability} not declared`)
    }
    // Gate 3: the capability must be granted by the user.
    if (!hasCapability(granted, capability)) {
      return this.deny(id, 'not-granted', `${capability} not granted`)
    }

    const paramsRecord = isRecord(params) ? params : {}
    const toolName = typeof paramsRecord.toolName === 'string' ? paramsRecord.toolName : ''
    if (!runtime.manifest.tools.some((tool) => tool.name === toolName)) {
      return this.deny(id, 'unknown_method', `unknown tool ${toolName}`)
    }
    // Gate 4: narrow unsafe input parameters. The final URL is derived from the manifest
    // definition + interpolated input and is re-checked by the executor's host whitelist on
    // every hop (including redirects); this gate rejects lexical escapes in path-bearing inputs.
    const narrowed = this.narrowParams(runtime, paramsRecord)
    if (narrowed === null) return this.deny(id, 'unsafe-param', 'unsafe parameter shape')

    this.touch(id)
    return { decision: 'allow', id, runtime, narrowed }
  }

  /** Admit and execute an extension call (IPC path). */
  async handleCall(
    extensionId: unknown,
    method: string,
    params: unknown
  ): Promise<ExtensionCallResult> {
    const evaluated = await this.evaluateCall(extensionId, method, params)
    if (evaluated.decision === 'deny') {
      return { decision: 'deny', reason: evaluated.reason }
    }
    const { id, runtime, narrowed } = evaluated
    return {
      decision: 'allow',
      run: async () => {
        this.touch(id)
        return await this.service.executeHttpRequest(runtime, {
          toolName: narrowed.toolName,
          input: narrowed.input
        })
      }
    }
  }

  private deny(
    id: string,
    reason: DenyReason,
    detail: string
  ): { decision: 'deny'; reason: DenyReason } {
    this.options.onDenied?.(id, reason, detail)
    return { decision: 'deny', reason }
  }

  /**
   * Narrow the call params. Rejects shapes that are not a `{ toolName, input }` record and
   * applies pathScopes to path-bearing input values so a path cannot lexically escape the
   * declared workspace scope. Path normalization via realpath is done at the executor level.
   */
  private narrowParams(
    runtime: RuntimeExtension,
    params: Record<string, unknown>
  ): { toolName: string; input: Record<string, unknown> } | null {
    const toolName = typeof params.toolName === 'string' ? params.toolName : ''
    const input = isRecord(params.input) ? params.input : {}
    const scopes = runtime.manifest.permissions?.pathScopes
    if (!scopes || scopes.length === 0) return { toolName, input }
    const root = '' // pathScopes are relative to the workspace; executor resolves the root.
    const narrowed: Record<string, unknown> = { ...input }
    for (const key of Object.keys(input)) {
      const value = input[key]
      if (typeof value !== 'string') continue
      if (isPathKey(key) && !matchesPathScope(scopes, value, root)) return null
      narrowed[key] = value
    }
    return { toolName, input: narrowed }
  }

  private touch(id: string): void {
    this.touchedAt.set(id, Date.now())
    const current = this.lifecycle.get(id)
    // A call that finishes while the extension awaits re-approval must not promote it back to
    // `active`: the next `lifecycleFor` would then short-circuit and skip the baseline check for
    // the rest of the process lifetime.
    if (current === 'pending-approval' || current === 'disabled' || current === 'error') return
    this.lifecycle.set(id, 'active')
  }

  /** Track lifecycle lazily, triggering activation on first use (lazy activation). */
  private async lifecycleFor(
    id: string,
    runtime: RuntimeExtension,
    state: ExtensionState
  ): Promise<ExtensionLifecycleState> {
    const current = this.lifecycle.get(id)
    if (current === 'pending-approval' || current === 'disabled' || current === 'error')
      return current
    if (current === 'active' || current === 'asleep') {
      // An already-activated extension skips the (file-backed) baseline check, but only while
      // the manifest it was activated against is still the one on disk. A manifest replaced
      // behind our back must fall through to the approval path instead of inheriting the state.
      if (this.lifecycleFingerprint.get(id) === capabilityFingerprint(runtime.manifest))
        return current
    }
    if (!state.enabled) {
      this.lifecycle.set(id, 'disabled')
      this.lifecycleFingerprint.delete(id)
      return 'disabled'
    }
    if (await this.escalationPending(id, runtime)) {
      this.lifecycle.set(id, 'pending-approval')
      this.lifecycleFingerprint.delete(id)
      return 'pending-approval'
    }
    this.lifecycle.set(id, 'active')
    this.lifecycleFingerprint.set(id, capabilityFingerprint(runtime.manifest))
    this.touch(id)
    return 'active'
  }

  /** Start the idle sweep; idempotent. Optional overrides are for tests. */
  startIdleSweep(overrides?: { sweepIntervalMs?: number; idleTimeoutMs?: number }): void {
    if (this.sweepTimer) return
    const interval = overrides?.sweepIntervalMs ?? this.options.sweepIntervalMs ?? 60_000
    const timeout = overrides?.idleTimeoutMs ?? this.options.idleTimeoutMs ?? 5 * 60_000
    this.sweepTimer = setInterval(() => {
      const now = Date.now()
      for (const [id, lastTouched] of this.touchedAt) {
        if (now - lastTouched > timeout) {
          this.touchedAt.delete(id)
          if (this.lifecycle.get(id) === 'active') this.lifecycle.set(id, 'asleep')
        }
      }
    }, interval)
    if (this.sweepTimer.unref) this.sweepTimer.unref()
  }

  /** Tear down the idle sweep. */
  stopIdleSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  /** Runtime capability mutation. Only declared kinds can be granted (fails closed otherwise). */
  async grantCapability(
    extensionId: unknown,
    kinds: readonly ExtensionCapabilityKind[]
  ): Promise<{ ok: boolean; granted: ExtensionCapabilityKind[] }> {
    const id = typeof extensionId === 'string' ? extensionId : ''
    const runtime = await this.service.getRuntime(id)
    const state = await this.stateStore.getOrCreate(id)
    const { granted, approvedRequired } = await this.capabilityState(id, runtime, state)
    const requested = [...new Set(kinds)]
    const bound = new Set(this.declaredBound(runtime))
    if (requested.some((kind) => !bound.has(kind))) return { ok: false, granted: [...granted] }
    const nextGranted = [...new Set([...granted, ...requested])]
    await this.persistCapabilities(id, nextGranted, approvedRequired)
    return { ok: true, granted: nextGranted }
  }

  /**
   * Revoke a capability. Revoking a required capability leaves the extension unable to run, so
   * it is put into a disabled state — the alternative (every call silently denied) hides the cause.
   */
  async revokeCapability(
    extensionId: unknown,
    kinds: readonly ExtensionCapabilityKind[]
  ): Promise<ExtensionCapabilityKind[]> {
    const id = typeof extensionId === 'string' ? extensionId : ''
    const runtime = await this.service.getRuntime(id)
    const state = await this.stateStore.getOrCreate(id)
    const { granted, approvedRequired } = await this.capabilityState(id, runtime, state)
    const revokeSet = new Set(kinds)
    const nextGranted = granted.filter((kind) => !revokeSet.has(kind))
    const required = this.requiredBound(runtime)
    const lostRequired = required.some((kind) => !nextGranted.includes(kind))
    if (lostRequired) {
      // A required capability gone ⇒ the extension can no longer run ⇒ disable it explicitly.
      await this.stateStore.update(id, { granted: nextGranted, enabled: false })
      this.lifecycle.set(id, 'disabled')
    } else {
      await this.persistCapabilities(id, nextGranted, approvedRequired)
    }
    return nextGranted
  }

  /**
   * Whether the durable approval baseline no longer covers what the current manifest can do.
   * A missing baseline is only "first install" for an extension that has never been installed;
   * for an existing installation it means the baseline was lost (file deleted, corrupted, or
   * written by a build without approvals) and it must fail closed rather than adopt the current
   * manifest as if the user had approved it.
   */
  private async escalationPending(id: string, runtime: RuntimeExtension): Promise<boolean> {
    const approval = await this.approvalStore.get(id)
    if (!approval || approval.approvedRequired === undefined) {
      return (await this.stateStore.get(id)) !== null
    }
    if (capabilityEscalated(approval.approvedRequired, this.requiredBound(runtime))) return true
    // A record without a fingerprint predates the fingerprint field. It still carries the
    // approved required set, so treat it as legacy rather than as an escalation.
    return (
      approval.approvedFingerprint !== undefined &&
      approval.approvedFingerprint !== capabilityFingerprint(runtime.manifest)
    )
  }

  /**
   * Re-approve after an escalation. The IPC channel is reachable from the renderer, so this
   * must never act as an unauthenticated privilege grant: it only proceeds when an escalation
   * is actually pending, and it grants the newly required capabilities rather than reusing the
   * stale grant set.
   */
  async approveRequiredCapabilities(extensionId: unknown): Promise<void> {
    const id = typeof extensionId === 'string' ? extensionId : ''
    const runtime = await this.service.getRuntime(id)
    const state = await this.stateStore.getOrCreate(id)
    // An unreadable baseline has no record to compare against, so the pending state raised by
    // checkEscalation()/lifecycleFor() is what authorises the re-approval in that case. When the
    // baseline is intact, an actual escalation must be pending — never a bare IPC call.
    if (
      this.lifecycle.get(id) !== 'pending-approval' &&
      !(await this.escalationPending(id, runtime))
    ) {
      throw new Error('No capability approval is pending for ' + id)
    }
    const required = this.requiredBound(runtime)
    const fingerprint = capabilityFingerprint(runtime.manifest)
    const granted = [...new Set([...(state.granted ?? []), ...required])]
    await this.persistCapabilities(id, granted, required)
    await this.approvalStore.update(id, {
      approvedRequired: required,
      approvedFingerprint: fingerprint
    })
    this.lifecycle.set(id, state.enabled ? 'idle' : 'disabled')
    this.lifecycleFingerprint.set(id, fingerprint)
  }

  /** Declared and granted capability surface for the UI. */
  async describe(extensionId: unknown): Promise<{
    required: ExtensionCapabilityKind[]
    optional: ExtensionCapabilityKind[]
    granted: ExtensionCapabilityKind[]
    lifecycle: ExtensionLifecycleState
  }> {
    const id = typeof extensionId === 'string' ? extensionId : ''
    const runtime = await this.service.getRuntime(id)
    const state = await this.stateStore.getOrCreate(id)
    const { granted } = await this.capabilityState(id, runtime, state)
    const declared = this.declaredBound(runtime)
    const required = this.requiredBound(runtime)
    const optional = declared.filter((kind) => !required.includes(kind))
    return { required, optional, granted, lifecycle: this.lifecycle.get(id) ?? 'idle' }
  }

  /**
   * On install/update, compare the manifest against the durable approval baseline and put an
   * escalated extension into `pending-approval`. Only a caller that knows this is a genuine
   * first install may record a baseline without blocking: for any other caller a missing
   * baseline means it was lost, which must not turn into an implicit approval.
   * The baseline lives outside the per-install state so remove + reinstall cannot reset it.
   */
  async checkEscalation(
    extensionId: unknown,
    options: { firstInstall?: boolean } = {}
  ): Promise<ExtensionLifecycleState> {
    const id = typeof extensionId === 'string' ? extensionId : ''
    // Read the durable baseline before getRuntime() creates a fresh per-install state row.
    const prior = await this.approvalStore.get(id)
    const runtime = await this.service.getRuntime(id)
    const state = await this.stateStore.getOrCreate(id)
    const required = this.requiredBound(runtime)
    const fingerprint = capabilityFingerprint(runtime.manifest)
    if (!prior || prior.approvedRequired === undefined) {
      if (options.firstInstall !== true) {
        // Installed before, but nothing verifiable about what was approved: fail closed.
        this.lifecycle.set(id, 'pending-approval')
        this.lifecycleFingerprint.delete(id)
        return 'pending-approval'
      }
      await this.persistCapabilities(
        id,
        state.granted ?? [...required],
        state.approvedRequired ?? required
      )
      await this.approvalStore.update(id, {
        approvedRequired: required,
        approvedFingerprint: fingerprint
      })
      this.lifecycle.set(id, state.enabled ? 'idle' : 'disabled')
      this.lifecycleFingerprint.set(id, fingerprint)
      return state.enabled ? 'idle' : 'disabled'
    }
    if (await this.escalationPending(id, runtime)) {
      this.lifecycle.set(id, 'pending-approval')
      this.lifecycleFingerprint.delete(id)
      return 'pending-approval'
    }
    // Keep the baseline aligned with non-escalating changes (e.g. a version bump).
    await this.approvalStore.update(id, {
      approvedRequired: required,
      approvedFingerprint: fingerprint
    })
    this.lifecycle.set(id, state.enabled ? 'idle' : 'disabled')
    this.lifecycleFingerprint.set(id, fingerprint)
    return state.enabled ? 'idle' : 'disabled'
  }
}
