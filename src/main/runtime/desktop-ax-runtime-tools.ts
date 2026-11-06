import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { systemPreferences } from 'electron'
import { RuntimeError } from '../../shared/runtime/contracts'
import type { ToolContext, ToolDefinition } from '../../runtime/tools/tool-executor'
import {
  agentDesktopFailure,
  mayRetrySafely,
  runAgentDesktop,
  type AgentDesktopReply,
  type AgentDesktopRunInput
} from '../agent-desktop/cli-client'
import {
  AGENT_DESKTOP_ACTIONS,
  AGENT_DESKTOP_SCROLL_DIRECTIONS,
  AGENT_DESKTOP_SURFACES,
  DESKTOP_AX_ADJUST_TOOL,
  DESKTOP_AX_CLICK_TOOL,
  DESKTOP_AX_INSPECT_TOOL,
  DESKTOP_AX_INPUT_TEXT_TOOL,
  DESKTOP_AX_LAUNCH_TOOL,
  DESKTOP_AX_LIST_TOOL,
  DESKTOP_AX_SNAPSHOT_TOOL,
  agentDesktopCommandForValidation,
  agentDesktopSessionScope,
  buildAgentDesktopPlan,
  type AgentDesktopScope,
  type AgentDesktopToolName
} from '../agent-desktop/args'
import {
  isPinnedAgentDesktopBinary,
  probeAgentDesktop,
  type AgentDesktopPlatform,
  type AgentDesktopStatus
} from '../agent-desktop/detector'
import { renderInventory, renderMatches, renderSnapshot } from '../agent-desktop/snapshot-shrink'
import { olaDataRoot } from '../lib/ola-data-root'

const MAX_APP_CHARS = 200
const MAX_REF_CHARS = 80
const MAX_TEXT_CHARS = 320
const MAX_VALUE_CHARS = 160
// agent-desktop keeps one snapshot state per session directory. Nothing removes it on run
// teardown, so an idle week is treated as abandonment rather than a live session.
const STALE_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000

type SchemaProperty = {
  type: 'string' | 'integer' | 'boolean'
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  enum?: readonly string[]
  description?: string
}

const timeoutProperty: SchemaProperty = {
  type: 'integer',
  minimum: 1_000,
  maximum: 15_000,
  description: 'How long the operating system may take to answer. Defaults to 15000.'
}

const appProperty: SchemaProperty = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_APP_CHARS,
  description: 'Application name or bundle id, as the operating system shows it.'
}

const optionalAppProperty: SchemaProperty = {
  ...appProperty,
  minLength: undefined,
  description: 'Application to scope the call to. Pair it with rootRef to search inside one ref.'
}

const surfaceProperty: SchemaProperty = {
  type: 'string',
  enum: AGENT_DESKTOP_SURFACES,
  description: 'Overlay to read instead of the window: a menu, sheet, popover or alert.'
}

const actionAppProperty: SchemaProperty = {
  ...appProperty,
  description:
    'Application the ref belongs to, exactly as the snapshot named it. It binds the action to a lock; it is not sent to the operating system.'
}

const refProperty: SchemaProperty = {
  type: 'string',
  minLength: 3,
  maxLength: MAX_REF_CHARS,
  description: 'Qualified ref from the most recent snapshot or search, e.g. "@s8f3k2p9:e12".'
}

const schemas: Record<AgentDesktopToolName, Record<string, unknown>> = {
  [DESKTOP_AX_LAUNCH_TOOL]: {
    type: 'object',
    properties: { app: appProperty, timeoutMs: timeoutProperty },
    required: ['app'],
    additionalProperties: false
  },
  [DESKTOP_AX_LIST_TOOL]: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['apps', 'windows', 'surfaces'],
        description: 'What to inventory: running apps, one app’s windows, or its surfaces.'
      },
      app: optionalAppProperty,
      timeoutMs: timeoutProperty
    },
    required: ['kind'],
    additionalProperties: false
  },
  [DESKTOP_AX_SNAPSHOT_TOOL]: {
    type: 'object',
    properties: {
      app: appProperty,
      windowId: {
        type: 'string',
        maxLength: 60,
        description: 'Window id from desktop_ax_list, when the app has several.'
      },
      surface: surfaceProperty,
      waitFor: {
        type: 'string',
        maxLength: 128,
        description: 'Poll until an element matches this role:text selector, e.g. "button:Save".'
      },
      timeoutMs: timeoutProperty
    },
    required: ['app'],
    additionalProperties: false
  },
  [DESKTOP_AX_INSPECT_TOOL]: {
    type: 'object',
    properties: {
      app: optionalAppProperty,
      rootRef: {
        type: 'string',
        maxLength: 80,
        description: 'A qualified ref (@snapshot:eN) from an earlier result, to search inside it.'
      },
      surface: surfaceProperty,
      role: { type: 'string', maxLength: 40, description: 'e.g. button, textfield, checkbox.' },
      name: { type: 'string', maxLength: 128, description: 'Accessible name, matched loosely.' },
      text: { type: 'string', maxLength: 128, description: 'Text in the element or its subtree.' },
      exact: { type: 'boolean', description: 'Require an exact name match.' },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
      timeoutMs: timeoutProperty
    },
    additionalProperties: false
  },
  [DESKTOP_AX_CLICK_TOOL]: {
    type: 'object',
    properties: {
      app: actionAppProperty,
      ref: refProperty,
      timeoutMs: timeoutProperty
    },
    required: ['app', 'ref'],
    additionalProperties: false
  },
  [DESKTOP_AX_INPUT_TEXT_TOOL]: {
    type: 'object',
    properties: {
      app: actionAppProperty,
      ref: refProperty,
      text: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_TEXT_CHARS,
        description: 'Text to enter. On Windows this replaces the field; elsewhere it is inserted.'
      },
      timeoutMs: timeoutProperty
    },
    required: ['app', 'ref', 'text'],
    additionalProperties: false
  },
  [DESKTOP_AX_ADJUST_TOOL]: {
    type: 'object',
    properties: {
      app: actionAppProperty,
      ref: refProperty,
      action: {
        type: 'string',
        enum: AGENT_DESKTOP_ACTIONS,
        description: 'What to do: scroll, select an option, or set a switch/disclosure state.'
      },
      direction: {
        type: 'string',
        enum: AGENT_DESKTOP_SCROLL_DIRECTIONS,
        description: 'Scroll only. Defaults to down.'
      },
      amount: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        description: 'Scroll only: how many units, default 3.'
      },
      value: {
        type: 'string',
        maxLength: MAX_VALUE_CHARS,
        description: 'Select only: the option to choose, as its accessible name reads.'
      },
      timeoutMs: timeoutProperty
    },
    required: ['app', 'ref', 'action'],
    additionalProperties: false
  }
}

const descriptions: Record<AgentDesktopToolName, string> = {
  [DESKTOP_AX_LAUNCH_TOOL]:
    'Start or attach to a desktop application so it can be observed through accessibility snapshots. It does not move the pointer, change focus, or send keystrokes.',
  [DESKTOP_AX_LIST_TOOL]:
    'List running desktop applications, the windows of one application, or its accessibility surfaces. Reads the operating system’s own inventory; nothing is changed or focused.',
  [DESKTOP_AX_SNAPSHOT_TOOL]:
    'Read one window as a compact outline of roles, names and refs. Elements that did not fit are counted, and a ref marks each branch worth drilling. Reading has no side effects: no click, no keystroke, no focus change.',
  [DESKTOP_AX_INSPECT_TOOL]:
    'Search a window, an overlay or one ref’s subtree for elements matching a role, name or text, and return their refs. Prefer this over a second full snapshot when you already know what you are looking for.',
  [DESKTOP_AX_CLICK_TOOL]:
    'Run one element’s own press action, addressed by its ref. This is semantic: the pointer does not move, nothing is focused, and no keystroke is sent. An element the operating system can no longer identify is refused rather than guessed at.',
  [DESKTOP_AX_INPUT_TEXT_TOOL]:
    'Write text into one text element, addressed by its ref. It is applied to the element directly, not typed on a keyboard, so the window keeps focus. Some fields accept a write without displaying it: read the element again before relying on it.',
  [DESKTOP_AX_ADJUST_TOOL]:
    'Scroll a container, choose an option in a list, or set a checkbox, switch or disclosure by its ref. Check, uncheck, expand and collapse set a stated condition; toggle reverses whatever the element currently reports. Scrolling has no semantic path on Linux and is refused there.'
}

function rejectInput(): never {
  throw new RuntimeError('INVALID_TOOL_INPUT')
}

function checkProperty(property: SchemaProperty, value: unknown): void {
  if (property.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) rejectInput()
    if (property.minimum !== undefined && value < property.minimum) rejectInput()
    if (property.maximum !== undefined && value > property.maximum) rejectInput()
    return
  }
  if (typeof value !== property.type) rejectInput()
  if (property.type === 'boolean') return
  const text = value as string
  if (property.minLength !== undefined && text.trim().length < property.minLength) rejectInput()
  if (property.maxLength !== undefined && text.length > property.maxLength) rejectInput()
  if (property.enum && !property.enum.includes(text)) rejectInput()
}

/**
 * `validate` is the only place an input error still reaches the model as its own code: a throw from
 * `execute` collapses into the generic TOOL_FAILED. So the argv builder is asked to build the
 * command here, which means a call that would produce a rejected argv is refused before it can be
 * authorized, approved, or spawned.
 */
function validateInput(
  tool: AgentDesktopToolName,
  value: unknown,
  platform: AgentDesktopPlatform
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) rejectInput()
  const input = value as Record<string, unknown>
  const schema = schemas[tool] as {
    properties?: Record<string, SchemaProperty>
    required?: string[]
  }
  const properties = schema.properties ?? {}
  if (Object.keys(input).some((key) => !properties[key])) rejectInput()
  if (schema.required?.some((key) => input[key] === undefined)) rejectInput()
  for (const [key, entry] of Object.entries(input)) {
    const property = properties[key]
    if (!property) rejectInput()
    checkProperty(property, entry)
  }
  agentDesktopCommandForValidation(tool, input, platform)
  return input
}

function appOf(input: Record<string, unknown>): string {
  return typeof input.app === 'string' ? input.app.trim() : ''
}

function sessionKey(context: ToolContext): string {
  return `desktop-ax:${context.run.workspaceId}:${context.run.sessionId}:session`
}

/** Model text must not be able to forge a lock key, so the app identity is hashed. */
function appKey(app: string): string {
  const digest = createHash('sha256').update(app.trim().toLowerCase()).digest('hex').slice(0, 16)
  return `desktop-ax:app:${digest}`
}

/** Everything a call needs that is fixed for the process rather than for the run. */
type AgentDesktopBackend = {
  binaryPath: string
  stateRoot: string
  platform: AgentDesktopPlatform
}

async function agentDesktopScope(
  context: ToolContext,
  backend: AgentDesktopBackend
): Promise<AgentDesktopScope> {
  const scope = agentDesktopSessionScope(
    backend.stateRoot,
    context.run.workspaceId,
    context.run.sessionId,
    context.run.taskId,
    backend.platform
  )
  await mkdir(scope.home, { recursive: true, mode: 0o700 })
  await pruneStaleState(backend.stateRoot, scope.home)
  return scope
}

async function pruneStaleState(stateRoot: string, keep: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(stateRoot)
  } catch {
    return
  }
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(stateRoot, entry)
      if (path === keep) return
      try {
        const info = await stat(path)
        if (Date.now() - info.mtimeMs < STALE_STATE_TTL_MS) return
        await rm(path, { recursive: true, force: true })
      } catch {
        // A sibling directory that vanished or refuses to be read is not this run's problem.
      }
    })
  )
}

/**
 * The allowlist is a hard bound, so it has to land before an approval prompt is offered: a dialog
 * for a launch Ola would then refuse anyway trains the user to approve reflexively. `prepare` is
 * the first hook that runs ahead of authorization, and a throw there reads to the model as
 * PERMISSION_DENIED rather than as a reason to retry with a different spelling.
 */
function assertAppAllowed(app: string, allowedApps?: readonly string[]): void {
  if (!allowedApps?.length) return
  const normalized = app.trim().toLowerCase()
  if (!allowedApps.some((entry) => entry.trim().toLowerCase() === normalized)) {
    throw new RuntimeError('AGENT_DESKTOP_APP_NOT_ALLOWED')
  }
}

/** The bound is only useful to the model if it is in the prompt rather than only in the refusal. */
function allowlistNotice(allowedApps?: readonly string[]): string {
  if (!allowedApps?.length) return ''
  const named = allowedApps.slice(0, 20).join(', ')
  const rest = allowedApps.length > 20 ? ` and ${String(allowedApps.length - 20)} more` : ''
  return ` Ola is limited to these applications: ${named}${rest}. Naming anything else is refused.`
}

function launchSummary(reply: AgentDesktopReply, app: string): string {
  const pid = typeof reply.data.pid === 'number' ? ` pid=${reply.data.pid}` : ''
  return `Launched ${app}${pid}. Confirm the application is in the expected state before acting on it.`
}

/**
 * Upstream reports `delivered_verified` only when it read the effect back, and `delivered_unverified`
 * when the application claimed success without an observable change. The second case is not a
 * success Ola may let the model build on: a repeated press can submit twice and a repeated toggle
 * undoes itself, so the reply names the doubt and points at the only way to settle it.
 */
function actionSummary(
  tool: AgentDesktopToolName,
  input: Record<string, unknown>,
  reply: AgentDesktopReply
): string {
  const ref = typeof input.ref === 'string' ? input.ref : 'the element'
  const action = typeof input.action === 'string' ? input.action : 'adjusted'
  const app = appOf(input)
  const head =
    tool === DESKTOP_AX_CLICK_TOOL
      ? `Pressed ${ref}`
      : tool === DESKTOP_AX_INPUT_TEXT_TOOL
        ? `Wrote text into ${ref}`
        : `${action} ${ref}`
  const delivery = reply.disposition.delivery
  const proof =
    delivery === 'delivered_verified'
      ? 'The operating system observed the change.'
      : delivery === 'delivered_unverified'
        ? 'UNCONFIRMED: the application accepted it, but no change was read back.'
        : 'UNCONFIRMED: no delivery proof came back.'
  const next =
    delivery === 'delivered_verified'
      ? 'Read the window again before the next action.'
      : 'Do not repeat this call. Take a snapshot and read what the screen actually says.'
  return `${head}${app ? ` in ${app}` : ''}. ${proof} ${next}`
}

async function runPlan(
  tool: AgentDesktopToolName,
  input: Record<string, unknown>,
  context: ToolContext,
  backend: AgentDesktopBackend
): Promise<AgentDesktopReply> {
  const scope = await agentDesktopScope(context, backend)
  const plan = buildAgentDesktopPlan(tool, input, scope)
  const run: AgentDesktopRunInput = {
    binaryPath: backend.binaryPath,
    argv: plan.argv,
    env: plan.env,
    timeoutMs: plan.timeoutMs,
    signal: context.signal,
    pinned: isPinnedAgentDesktopBinary(backend.binaryPath)
  }
  const reply = await runAgentDesktop(run)
  // One retry, and only when the CLI itself reports the first delivery was not attempted. Upstream
  // documents `not_delivered` as the only safe value, which is what `mayRetrySafely` requires, so a
  // click that may have landed is never sent twice by this client. A stale ref is the one safe
  // failure that repeating cannot fix: the ref is gone, and only a new snapshot brings another one.
  if (mayRetrySafely(reply) && reply.code !== 'STALE_REF') return runAgentDesktop(run)
  return reply
}

function macAccessibilityState(): { accessibility: string } | undefined {
  if (process.platform !== 'darwin') return undefined
  try {
    // `false` reads the state without triggering the system prompt; the user must opt in in
    // System Settings, and an agent tool call must never be what asks for it.
    return {
      accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied'
    }
  } catch {
    return undefined
  }
}

export type DesktopAxRuntimeToolOptions = {
  allowedApps?: readonly string[]
  /** Overrides the OLA data root; contract tests point it at a temporary directory. */
  stateRoot?: string
  status?: AgentDesktopStatus
}

/**
 * Reads skip the approval prompt, so their entire safety value is that they cannot change anything.
 * Snapshot and search still register refs in the session's state directory, which is why they take
 * the session lock; an inventory registers nothing and may run in parallel.
 */
const readers: Partial<
  Record<
    AgentDesktopToolName,
    {
      serialize: boolean
      render: (data: Record<string, unknown>, input: Record<string, unknown>) => string
    }
  >
> = {
  [DESKTOP_AX_LIST_TOOL]: {
    serialize: false,
    render: (data, input) => renderInventory(String(input.kind ?? 'apps').toLowerCase(), data)
  },
  [DESKTOP_AX_SNAPSHOT_TOOL]: { serialize: true, render: (data) => renderSnapshot(data) },
  [DESKTOP_AX_INSPECT_TOOL]: { serialize: true, render: (data) => renderMatches(data) }
}

const toolOrder: AgentDesktopToolName[] = [
  DESKTOP_AX_LAUNCH_TOOL,
  DESKTOP_AX_LIST_TOOL,
  DESKTOP_AX_SNAPSHOT_TOOL,
  DESKTOP_AX_INSPECT_TOOL,
  DESKTOP_AX_CLICK_TOOL,
  DESKTOP_AX_INPUT_TEXT_TOOL,
  DESKTOP_AX_ADJUST_TOOL
]

export function createDesktopAxRuntimeTools(
  options: DesktopAxRuntimeToolOptions = {}
): ToolDefinition[] {
  const status =
    options.status ?? probeAgentDesktop(undefined, undefined, undefined, macAccessibilityState())
  // An unavailable platform must not advertise the tool; a half-usable accessibility backend is
  // worse than none, because the model would keep retrying a command the OS refuses.
  if (!status.available || !status.binaryPath) return []
  const backend: AgentDesktopBackend = {
    binaryPath: status.binaryPath,
    stateRoot: options.stateRoot ?? join(olaDataRoot(), 'agent-desktop'),
    platform: status.platform
  }
  return toolOrder.map((tool) => {
    const reader = readers[tool]
    return {
      name: tool,
      description: descriptions[tool] + allowlistNotice(options.allowedApps),
      inputSchema: schemas[tool],
      effect: reader ? 'read' : 'write',
      ...(reader?.serialize ? { serializeReads: true } : {}),
      validate: (input) => validateInput(tool, input, backend.platform),
      prepare: (input) => {
        const normalized = input as Record<string, unknown>
        const app = appOf(normalized)
        if (app) assertAppAllowed(app, options.allowedApps)
        return Promise.resolve(normalized)
      },
      resources: (input, context) => {
        const app = appOf(input as Record<string, unknown>)
        return Promise.resolve(app ? [sessionKey(context), appKey(app)] : [sessionKey(context)])
      },
      execute: async (input, context) => {
        const normalized = validateInput(tool, input, backend.platform)
        const reply = await runPlan(tool, normalized, context, backend)
        if (!reply.ok) return agentDesktopFailure(reply)
        if (reader) return reader.render(reply.data, normalized)
        return tool === DESKTOP_AX_LAUNCH_TOOL
          ? launchSummary(reply, appOf(normalized))
          : actionSummary(tool, normalized, reply)
      }
    } satisfies ToolDefinition
  })
}
