import { webContents } from 'electron'
import { RuntimeError } from '../../shared/runtime/contracts'
import type { ToolDefinition } from '../../runtime/tools/tool-executor'
import { checkBrowserUrlAccess } from '../browser/browser-access-policy'
import {
  captureRegisteredBrowserGuest,
  findBrowserUserTab,
  takeBrowserRunControl
} from '../browser/browser-service'
import { stageRuntimeImageAsset } from '../../runtime/storage/runtime-image-assets'

type BrowserToolName =
  | 'BrowserNavigate'
  | 'BrowserGetContent'
  | 'BrowserScreenshot'
  | 'BrowserSnapshot'
  | 'BrowserClick'
  | 'BrowserType'
  | 'BrowserScroll'

const names: BrowserToolName[] = [
  'BrowserNavigate',
  'BrowserGetContent',
  'BrowserScreenshot',
  'BrowserSnapshot',
  'BrowserClick',
  'BrowserType',
  'BrowserScroll'
]

const schemas: Record<BrowserToolName, Record<string, unknown>> = {
  BrowserNavigate: {
    type: 'object',
    properties: {
      url: { type: 'string', maxLength: 8192 },
      action: { type: 'string', enum: ['goto', 'back', 'forward', 'refresh'] }
    },
    additionalProperties: false
  },
  BrowserGetContent: {
    type: 'object',
    properties: {
      selector: { type: 'string', maxLength: 2048 },
      type: { type: 'string', enum: ['markdown', 'html'] }
    },
    additionalProperties: false
  },
  BrowserScreenshot: { type: 'object', properties: {}, additionalProperties: false },
  BrowserSnapshot: { type: 'object', properties: {}, additionalProperties: false },
  BrowserClick: {
    type: 'object',
    properties: { selector: { type: 'string', minLength: 1, maxLength: 2048 } },
    required: ['selector'],
    additionalProperties: false
  },
  BrowserType: {
    type: 'object',
    properties: {
      selector: { type: 'string', minLength: 1, maxLength: 2048 },
      text: { type: 'string', maxLength: 16_384 },
      clear: { type: 'boolean' },
      submit: { type: 'boolean' }
    },
    required: ['selector', 'text'],
    additionalProperties: false
  },
  BrowserScroll: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['up', 'down'] },
      amount: { type: 'number', minimum: 1, maximum: 10_000 }
    },
    additionalProperties: false
  }
}

const descriptions: Record<BrowserToolName, string> = {
  BrowserNavigate:
    'Navigate Ola’s Browser panel. Use goto with a URL, or back, forward, or refresh. A goto opens the panel tab when needed. Main checks the current project’s Browser domain policy.',
  BrowserGetContent:
    'Extract the current page as readable Markdown, or raw HTML with type="html". Use selector to limit extraction to one section. Navigate first.',
  BrowserScreenshot:
    'Capture the visible Browser panel page. Navigate first; use this to inspect visual layout.',
  BrowserSnapshot:
    'List visible links, buttons, and form controls with selectors. Call before BrowserClick or BrowserType, then take a fresh snapshot after navigation or state changes.',
  BrowserClick:
    'Click a CSS selector from BrowserSnapshot, or use text=<visible text>. The Browser panel scrolls the target into view before clicking.',
  BrowserType:
    'Type into an input, textarea, or contenteditable element selected from BrowserSnapshot. Existing content is replaced unless clear=false; submit=true presses Enter.',
  BrowserScroll:
    'Scroll the current Browser page up or down by the requested pixel amount, or one viewport when amount is omitted. Take a new snapshot after scrolling.'
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  return value as Record<string, unknown>
}

function validateInput(name: BrowserToolName, value: unknown): Record<string, unknown> {
  const input = record(value)
  const schema = schemas[name]
  const allowed = new Set(Object.keys((schema.properties as Record<string, unknown>) ?? {}))
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new RuntimeError('INVALID_TOOL_INPUT')
  const stringField = (key: string, max: number, required = false): void => {
    const field = input[key]
    if (field === undefined && !required) return
    if (typeof field !== 'string' || field.length > max || (required && !field.trim()))
      throw new RuntimeError('INVALID_TOOL_INPUT')
  }
  if (name === 'BrowserNavigate') {
    stringField('url', 8192)
    if (
      input.action !== undefined &&
      !['goto', 'back', 'forward', 'refresh'].includes(String(input.action))
    )
      throw new RuntimeError('INVALID_TOOL_INPUT')
  } else if (name === 'BrowserGetContent') {
    stringField('selector', 2048)
    if (input.type !== undefined && input.type !== 'markdown' && input.type !== 'html')
      throw new RuntimeError('INVALID_TOOL_INPUT')
  } else if (name === 'BrowserClick') {
    stringField('selector', 2048, true)
  } else if (name === 'BrowserType') {
    stringField('selector', 2048, true)
    stringField('text', 16_384, true)
    if (input.clear !== undefined && typeof input.clear !== 'boolean')
      throw new RuntimeError('INVALID_TOOL_INPUT')
    if (input.submit !== undefined && typeof input.submit !== 'boolean')
      throw new RuntimeError('INVALID_TOOL_INPUT')
  } else if (name === 'BrowserScroll') {
    if (input.direction !== undefined && input.direction !== 'up' && input.direction !== 'down')
      throw new RuntimeError('INVALID_TOOL_INPUT')
    if (
      input.amount !== undefined &&
      (typeof input.amount !== 'number' ||
        !Number.isFinite(input.amount) ||
        input.amount < 1 ||
        input.amount > 10_000)
    )
      throw new RuntimeError('INVALID_TOOL_INPUT')
  }
  return input
}

function normalizeUrl(value: string): string {
  const url = value.trim()
  if (/^https?:\/\//i.test(url) || url.startsWith('http://localhost')) return url
  return `https://${url}`
}

function tool(name: BrowserToolName): ToolDefinition {
  const read = ['BrowserGetContent', 'BrowserScreenshot', 'BrowserSnapshot'].includes(name)
  return {
    name,
    description: descriptions[name],
    inputSchema: schemas[name],
    effect: read ? 'read' : 'write',
    ...(read ? { serializeReads: true } : {}),
    validate: (input) => validateInput(name, input),
    resources: async (_input, context) => [
      `browser:${context.run.workspaceId}:${context.run.sessionId}`
    ],
    execute: async (input, context) => {
      if (context.run.unattended) throw new RuntimeError('BROWSER_UI_REQUIRED')
      const normalized = validateInput(name, input)
      if (name === 'BrowserScreenshot') {
        const tab = findBrowserUserTab({
          workspaceId: context.run.workspaceId,
          sessionId: context.run.sessionId,
          ...(context.run.projectId ? { projectId: context.run.projectId } : {})
        })
        const guest = webContents.fromId(tab.guestWebContentsId)
        if (!guest || guest.isDestroyed()) throw new RuntimeError('BROWSER_GUEST_UNAVAILABLE')
        const access = await checkBrowserUrlAccess(guest.getURL(), context.run.projectId)
        if (!access.allowed) throw new RuntimeError(access.reason ?? 'BROWSER_ACCESS_DENIED')
        takeBrowserRunControl({
          tabId: tab.ownership.tabId,
          hostWebContentsId: tab.hostWebContentsId,
          runId: context.run.runId
        })
        const captured = await captureRegisteredBrowserGuest({
          hostWebContentsId: tab.hostWebContentsId,
          guestWebContentsId: tab.guestWebContentsId,
          runId: context.run.runId
        })
        const asset = await stageRuntimeImageAsset({
          workspaceId: context.run.workspaceId,
          mimeType: captured.mediaType,
          base64: captured.data
        })
        return {
          text: `Screenshot captured: ${captured.width}x${captured.height}px - ${guest.getURL()}`,
          __runtimeToolImage: { mimeType: captured.mediaType, assetId: asset.assetId }
        }
      }
      if (!context.requestInteraction) throw new RuntimeError('BROWSER_UI_REQUIRED')
      const action = normalized.action ?? 'goto'
      if (name === 'BrowserNavigate' && action === 'goto') {
        if (typeof normalized.url !== 'string') throw new RuntimeError('INVALID_TOOL_INPUT')
        const decision = await checkBrowserUrlAccess(
          normalizeUrl(normalized.url),
          context.run.projectId
        )
        if (!decision.allowed) throw new RuntimeError(decision.reason ?? 'BROWSER_ACCESS_DENIED')
      }
      const response = await context.requestInteraction({
        interactionId: `browser-tool:${context.toolCallId ?? name}`,
        kind: 'browser-tool',
        payload: {
          toolName: name,
          input: normalized,
          sessionId: context.run.sessionId,
          projectId: context.run.projectId ?? null,
          workingFolder: context.run.workingDirectory ?? null
        },
        version: '1'
      })
      if (!response || typeof response !== 'object' || !('browserToolResult' in response))
        throw new RuntimeError('BROWSER_INTERACTION_FAILED')
      return (response as { browserToolResult: unknown }).browserToolResult
    }
  }
}

export function createBrowserRuntimeTools(): ToolDefinition[] {
  return names.map(tool)
}
