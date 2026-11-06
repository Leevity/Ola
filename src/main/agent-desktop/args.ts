import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { RuntimeError } from '../../shared/runtime/contracts'
import { mapAgentDesktopPlatform, type AgentDesktopPlatform } from './detector'

/**
 * The only place agent-desktop argv is built. Tools pass validated, typed input here; nothing
 * reaches `spawn` that is not produced by this module, which is what lets the red-line test
 * assert that the dangerous surface is physically absent rather than merely unused.
 */

export const DESKTOP_AX_LAUNCH_TOOL = 'desktop_ax_launch'
export const DESKTOP_AX_LIST_TOOL = 'desktop_ax_list'
export const DESKTOP_AX_SNAPSHOT_TOOL = 'desktop_ax_snapshot'
export const DESKTOP_AX_INSPECT_TOOL = 'desktop_ax_inspect'
export const DESKTOP_AX_CLICK_TOOL = 'desktop_ax_click'
export const DESKTOP_AX_INPUT_TEXT_TOOL = 'desktop_ax_input_text'
export const DESKTOP_AX_ADJUST_TOOL = 'desktop_ax_adjust'

export type AgentDesktopToolName =
  | typeof DESKTOP_AX_LAUNCH_TOOL
  | typeof DESKTOP_AX_LIST_TOOL
  | typeof DESKTOP_AX_SNAPSHOT_TOOL
  | typeof DESKTOP_AX_INSPECT_TOOL
  | typeof DESKTOP_AX_CLICK_TOOL
  | typeof DESKTOP_AX_INPUT_TEXT_TOOL
  | typeof DESKTOP_AX_ADJUST_TOOL

export type AgentDesktopListKind = 'apps' | 'windows' | 'surfaces'

/** The semantic element mutations Ola exposes. `press`, `hover`, `drag` and raw input are not here. */
export const AGENT_DESKTOP_ACTIONS = [
  'scroll',
  'select',
  'toggle',
  'check',
  'uncheck',
  'expand',
  'collapse'
] as const

export type AgentDesktopAction = (typeof AGENT_DESKTOP_ACTIONS)[number]

export const AGENT_DESKTOP_SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const

export type AgentDesktopPlan = {
  argv: string[]
  env: Record<string, string>
  timeoutMs: number
}

export type AgentDesktopScope = {
  session: string
  agentId: string
  home: string
  platform: AgentDesktopPlatform
}

/** Accepted by buildAgentDesktopPlan but never emitted by it. */
export const FORBIDDEN_ARGV_TOKENS = [
  '--headed',
  '--cdp',
  '--include-bounds',
  '--arg',
  '--env',
  '--force',
  '--activate',
  '--screenshot',
  '--debug',
  '--trace',
  '--trace-strict',
  '--no-attach'
] as const

/**
 * Verbs that exist upstream and must never be reachable from Ola. Physical input (`--headed` is
 * refused separately, but these are physical even when headed), anything that ends a process,
 * touches the clipboard or notifications, and `batch`, which would replay a whole argv list behind
 * the single-command audit the rest of this module provides.
 */
export const FORBIDDEN_COMMAND_NAMES = [
  'close-app',
  'quit',
  'kill',
  'permissions',
  'mcp',
  'batch',
  'session',
  'wait',
  'screenshot',
  'clipboard-get',
  'clipboard-set',
  'notification-action',
  'dismiss-notification',
  'dismiss-all-notifications',
  'open-system-surface',
  'focus',
  'focus-window',
  'resize-window',
  'move-window',
  'press',
  'hover',
  'drag',
  'double-click',
  'triple-click',
  'right-click',
  'mouse-click',
  'mouse-down',
  'mouse-move',
  'mouse-up',
  'mouse-wheel',
  'key-down',
  'key-up',
  'scroll-to',
  'clear'
] as const

const DEFAULT_TIMEOUT_MS = 15_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 15_000
const MAX_APP_CHARS = 200
const MAX_SELECTOR_CHARS = 128
const MAX_WINDOW_ID_CHARS = 60
const MAX_REF_CHARS = 80
const MAX_LIMIT = 20
const DEFAULT_LIMIT = 10
const MAX_TYPED_CHARS = 320
// `type` documents its own default budget as 5000ms plus 30ms per character.
const TYPED_BASE_MS = 5_000
const TYPED_CHAR_MS = 30
const DEFAULT_SCROLL_AMOUNT = 3
const MAX_SCROLL_AMOUNT = 10
const MAX_VALUE_CHARS = 160

const LIST_COMMANDS: Record<AgentDesktopListKind, string> = {
  apps: 'list-apps',
  windows: 'list-windows',
  surfaces: 'list-surfaces'
}

/** Closed set, taken from `snapshot --help`. Anything else is refused before the CLI sees it. */
export const AGENT_DESKTOP_SURFACES = [
  'window',
  'focused',
  'menu',
  'menubar',
  'sheet',
  'popover',
  'alert',
  'toolbar',
  'desktop',
  'taskbar',
  'system-tray',
  'system-tray-overflow',
  'notification-center',
  'quick-settings',
  'start-menu',
  'action-center',
  'dock',
  'spotlight',
  'menu-bar-extras'
] as const

export type AgentDesktopSurface = (typeof AGENT_DESKTOP_SURFACES)[number]

// agent-desktop refs are qualified with the snapshot that issued them (`@s8f3k2p9:e1`). A bare
// `@e1` survives argument parsing and only fails once the CLI starts resolving it, so the shape is
// enforced here: a ref that cannot work should not cost a spawn, an approval, or a permission gate.
const QUALIFIED_REF = /^@[A-Za-z0-9_-]{1,40}:e[0-9]{1,9}$/

/**
 * One state root per run session. Sharing one root across sessions would let a ref from another
 * session's snapshot resolve here, which is exactly the ownership check P2 cannot recover from.
 */
export function agentDesktopSessionScope(
  root: string,
  workspaceId: string,
  sessionId: string,
  subAgentId?: string,
  platform: AgentDesktopPlatform = mapAgentDesktopPlatform(process.platform)
): AgentDesktopScope {
  if (!isAbsolute(root)) throw new RuntimeError('INVALID_AGENT_DESKTOP_HOME')
  const digest = createHash('sha256')
    .update(`${workspaceId}\u0000${sessionId}`)
    .digest('hex')
    .slice(0, 24)
  const session = `ola-${digest}`
  const hashedAgentId = subAgentId
    ? createHash('sha256').update(subAgentId).digest('hex').slice(0, 12)
    : null
  return {
    session,
    agentId: hashedAgentId ? `ola-${hashedAgentId}` : 'ola-main',
    home: join(root, session),
    platform
  }
}

function clampTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(value)))
}

function requiredText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new RuntimeError('INVALID_TOOL_INPUT')
  }
  // Control characters and newlines would let one argument smuggle another.
  if (Array.from(value).some((character) => character.codePointAt(0)! < 0x20)) {
    throw new RuntimeError('INVALID_TOOL_INPUT')
  }
  return value.trim()
}

function optionalText(value: unknown, maximum: number): string {
  if (value === undefined || value === null) return ''
  return requiredText(value, maximum)
}

function optionalSurface(value: unknown): string {
  const surface = optionalText(value, 30)
  if (!surface) return ''
  if (!(AGENT_DESKTOP_SURFACES as readonly string[]).includes(surface)) {
    throw new RuntimeError('INVALID_TOOL_INPUT')
  }
  return surface
}

function optionalRef(value: unknown): string {
  if (value === undefined || value === null) return ''
  const ref = optionalText(value, MAX_REF_CHARS)
  if (!QUALIFIED_REF.test(ref)) throw new RuntimeError('INVALID_TOOL_INPUT')
  return ref
}

/** Action verbs are aimed at one element, so a ref is not optional and a bare one is not a ref. */
function requiredRef(value: unknown): string {
  const ref = optionalText(value, MAX_REF_CHARS)
  if (!QUALIFIED_REF.test(ref)) throw new RuntimeError('INVALID_TOOL_INPUT')
  return ref
}

function actionOf(value: unknown): AgentDesktopAction {
  const action = requiredText(value, 20).toLowerCase()
  if (!(AGENT_DESKTOP_ACTIONS as readonly string[]).includes(action)) {
    throw new RuntimeError('INVALID_TOOL_INPUT')
  }
  return action as AgentDesktopAction
}

function scrollDirection(value: unknown): string {
  if (value === undefined || value === null) return ''
  const direction = requiredText(value, 10).toLowerCase()
  if (!(AGENT_DESKTOP_SCROLL_DIRECTIONS as readonly string[]).includes(direction)) {
    throw new RuntimeError('INVALID_TOOL_INPUT')
  }
  return direction
}

function scrollAmount(value: unknown): number {
  if (value === undefined) return DEFAULT_SCROLL_AMOUNT
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return Math.min(MAX_SCROLL_AMOUNT, Math.max(1, Math.round(value)))
}

function listKindOf(value: unknown): AgentDesktopListKind {
  const kind = requiredText(value, 20).toLowerCase()
  if (kind !== 'apps' && kind !== 'windows' && kind !== 'surfaces') {
    throw new RuntimeError('INVALID_TOOL_INPUT')
  }
  return kind
}

function limitOf(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return Math.min(MAX_LIMIT, Math.max(1, Math.round(value)))
}

function exactOf(value: unknown): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new RuntimeError('INVALID_TOOL_INPUT')
  return value
}

/**
 * The verbs that accept `--timeout-ms`, verified against the pinned v1.1.0 help. `list-surfaces`
 * is deliberately absent: it declares no budget flag, and naming one is `INVALID_ARGS`
 * "unexpected argument '--timeout-ms' found" before the CLI does any work. The set is a whitelist
 * rather than a blacklist so a verb added later fails closed into the CLI's own default.
 */
const TIMEOUT_MS_COMMANDS = new Set([
  'snapshot',
  'find',
  'list-apps',
  'list-windows',
  'click',
  'type',
  'set-value',
  'select',
  'scroll',
  'toggle',
  'check',
  'uncheck',
  'expand',
  'collapse'
])

function budgetFlagFor(commandName: string): string | null {
  // Only `launch` spells its budget `--timeout`.
  if (commandName === 'launch') return '--timeout'
  return TIMEOUT_MS_COMMANDS.has(commandName) ? '--timeout-ms' : null
}

type AgentDesktopCommandParts = {
  /** Verb plus its own flags; the plan builder appends the session scope after these. */
  command: string[]
  /** Free-text positionals, emitted after `--` so text that starts with a dash cannot become a flag. */
  trailing: string[]
}

function buildCommand(
  tool: AgentDesktopToolName,
  input: Record<string, unknown>,
  platform: AgentDesktopPlatform
): AgentDesktopCommandParts {
  const parts = (command: string[], trailing: string[] = []): AgentDesktopCommandParts => ({
    command,
    trailing
  })

  if (tool === DESKTOP_AX_LAUNCH_TOOL) {
    // Verified against `agent-desktop launch --help`: `launch` rejects --wait-for outright
    // (INVALID_ARGS "Command 'launch' does not support --wait-for"), so waiting is a snapshot
    // concern and never part of a launch plan.
    return parts(['launch', requiredText(input.app, MAX_APP_CHARS)])
  }

  if (tool === DESKTOP_AX_LIST_TOOL) {
    const app = optionalText(input.app, MAX_APP_CHARS)
    const command = [LIST_COMMANDS[listKindOf(input.kind)]]
    return parts(app ? [...command, '--app', app] : command)
  }

  if (tool === DESKTOP_AX_SNAPSHOT_TOOL) {
    // `--skeleton` is what keeps a whole-window capture inside the result budget: it clamps depth
    // and reports `children_count` on every branch it cut, which is what the shrinker folds on.
    const command = [
      'snapshot',
      '--app',
      requiredText(input.app, MAX_APP_CHARS),
      '--skeleton',
      '-i',
      '--compact'
    ]
    const windowId = optionalText(input.windowId, MAX_WINDOW_ID_CHARS)
    if (windowId) command.push('--window-id', windowId)
    const surface = optionalSurface(input.surface)
    if (surface) command.push('--surface', surface)
    const waitFor = optionalText(input.waitFor, MAX_SELECTOR_CHARS)
    if (waitFor) command.push('--wait-for', waitFor)
    return parts(command)
  }

  if (tool === DESKTOP_AX_INSPECT_TOOL) {
    const app = optionalText(input.app, MAX_APP_CHARS)
    const rootRef = optionalRef(input.rootRef)
    const surface = optionalSurface(input.surface)
    const role = optionalText(input.role, 40)
    const name = optionalText(input.name, MAX_SELECTOR_CHARS)
    const text = optionalText(input.text, MAX_SELECTOR_CHARS)
    // A search with no filter is a dump, and a dump is the thing the budget exists to prevent.
    if (!role && !name && !text) throw new RuntimeError('INVALID_TOOL_INPUT')
    // `find` has to say which window it means, or it is a guess about the user's screen.
    if (!app && !rootRef && !surface) throw new RuntimeError('INVALID_TOOL_INPUT')
    // Upstream documents `--root` as incompatible with `--surface`, but the CLI only notices after the
    // permission gate. Refusing here is cheaper than a spawn that cannot work and reads the same.
    if (rootRef && surface) throw new RuntimeError('INVALID_TOOL_INPUT')
    const command = ['find']
    if (app) command.push('--app', app)
    if (rootRef) command.push('--root', rootRef)
    if (surface) command.push('--surface', surface)
    if (role) command.push('--role', role)
    if (name) command.push('--name', name)
    if (text) command.push('--text', text)
    if (exactOf(input.exact)) command.push('--exact')
    command.push('--limit', String(limitOf(input.limit)))
    return parts(command)
  }

  if (tool === DESKTOP_AX_CLICK_TOOL) {
    return parts(['click', requiredRef(input.ref)])
  }

  if (tool === DESKTOP_AX_INPUT_TEXT_TOOL) {
    const ref = requiredRef(input.ref)
    const text = requiredText(input.text, MAX_TYPED_CHARS)
    // macOS and Linux insert through the accessibility text path; Windows has no semantic write
    // for most fields, so the value is set on the element instead. The two are not the same
    // operation: `set-value` replaces, `type` inserts at the caret.
    return platform === 'windows'
      ? parts(['set-value', ref], ['--', text])
      : parts(['type', ref], ['--', text])
  }

  const action = actionOf(input.action)
  // A value belongs to `select` and the scroll knobs belong to `scroll`. Silently dropping an
  // argument the model meant to send would report an action that never happened.
  if (action !== 'select' && input.value !== undefined) throw new RuntimeError('INVALID_TOOL_INPUT')
  if (action !== 'scroll' && (input.direction !== undefined || input.amount !== undefined)) {
    throw new RuntimeError('INVALID_TOOL_INPUT')
  }
  if (action === 'scroll') {
    const command = ['scroll', requiredRef(input.ref)]
    const direction = scrollDirection(input.direction)
    if (direction) command.push('--direction', direction)
    command.push('--amount', String(scrollAmount(input.amount)))
    return parts(command)
  }
  if (action === 'select') {
    return parts(
      ['select', requiredRef(input.ref)],
      ['--', requiredText(input.value, MAX_VALUE_CHARS)]
    )
  }
  // No ref action takes an app or a window scope: `click`, `type` and the state verbs resolve the
  // element from the ref alone.
  return parts([action, requiredRef(input.ref)])
}

/**
 * Runs the same command construction a real call would, discarding the result, so a tool can report
 * an unacceptable combination from `validate()` instead of from `execute()`.
 */
export function agentDesktopCommandForValidation(
  tool: AgentDesktopToolName,
  input: Record<string, unknown>,
  platform: AgentDesktopPlatform = mapAgentDesktopPlatform(process.platform)
): string[] {
  const { command, trailing } = buildCommand(tool, input, platform)
  return [...command, ...trailing]
}

/**
 * `type` documents its own default budget as `5000ms plus 30 per character`, and an explicit budget
 * under that is a guaranteed TIMEOUT on a long string, so the floor rises with the text. The
 * character cap on typed input is what keeps that floor inside `MAX_TIMEOUT_MS`.
 */
function budgetMs(verb: string, input: Record<string, unknown>): number {
  const base = clampTimeout(input.timeoutMs)
  if (verb !== 'type') return base
  const chars = typeof input.text === 'string' ? Array.from(input.text).length : 0
  return Math.min(MAX_TIMEOUT_MS, Math.max(base, TYPED_BASE_MS + TYPED_CHAR_MS * chars))
}

export function buildAgentDesktopPlan(
  tool: AgentDesktopToolName,
  input: Record<string, unknown>,
  scope: AgentDesktopScope
): AgentDesktopPlan {
  const { command, trailing } = buildCommand(tool, input, scope.platform)
  const timeoutMs = budgetMs(command[0], input)
  const argv = [...command, '--session', scope.session, '--agent-id', scope.agentId]
  // The budget flag is a property of the verb, not of the tool: `launch` says `--timeout`, most
  // verbs say `--timeout-ms`, and `list-surfaces` says neither.
  const budgetFlag = budgetFlagFor(command[0])
  if (budgetFlag) argv.push(budgetFlag, String(timeoutMs))
  // A wait must settle inside the same budget the client timer is counting down, or the CLI would
  // still be polling when its process is killed.
  if (argv.includes('--wait-for')) argv.push('--wait-timeout', String(timeoutMs))
  // Free text goes last, behind the option terminator, because every flag above has to finish
  // parsing before the CLI starts reading positional values.
  argv.push(...trailing)

  const plan: AgentDesktopPlan = {
    argv,
    env: { AGENT_DESKTOP_HOME: scope.home },
    // The CLI bounds its own work; the client timer only guards a process that stopped talking. An
    // unbudgeted verb still gets the full wait, because a silent process has to die sometime.
    timeoutMs: timeoutMs + 5_000
  }
  assertPlanIsAllowed(plan)
  return plan
}

/**
 * Fail closed at construction time if a future edit ever reintroduces a forbidden surface.
 *
 * The flag scan reads every token, including values, so Ola can never type the literal string
 * `--headed` into a field. That false refusal is the cheaper side of the trade: a token that looks
 * like a red line should not be in a command line, whatever position it sits in.
 */
export function assertPlanIsAllowed(plan: AgentDesktopPlan): void {
  for (const token of plan.argv) {
    for (const forbidden of FORBIDDEN_ARGV_TOKENS) {
      if (token === forbidden || token.startsWith(`${forbidden}=`)) {
        throw new RuntimeError('AGENT_DESKTOP_FORBIDDEN_ARGUMENT')
      }
    }
  }
  if (FORBIDDEN_COMMAND_NAMES.includes(plan.argv[0] as (typeof FORBIDDEN_COMMAND_NAMES)[number])) {
    throw new RuntimeError('AGENT_DESKTOP_FORBIDDEN_COMMAND')
  }
  if (!isAbsolute(plan.env.AGENT_DESKTOP_HOME)) {
    throw new RuntimeError('INVALID_AGENT_DESKTOP_HOME')
  }
}
