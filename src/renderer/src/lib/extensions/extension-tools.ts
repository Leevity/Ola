import { toolRegistry } from '@renderer/lib/agent/tool-registry'
import type { ToolHandler } from '@renderer/lib/tools/tool-types'
import { encodeToolError } from '@renderer/lib/tools/tool-result-format'
import type { ExtensionInstance, ExtensionToolDefinition } from '../../../../shared/extension-types'
import { useExtensionStore } from '@renderer/stores/extension-store'
import { useChatStore } from '@renderer/stores/chat-store'
import { refreshExtensionWorkbenchContributions } from './extension-workbench'
import type { ToolDefinition } from '@renderer/lib/api/types'

const EXTENSION_TOOL_PREFIX = 'extension__'
let registeredExtensionToolNames: string[] = []
let refreshPromise: Promise<void> | null = null

type ObjectInputSchema = Extract<
  ToolHandler['definition']['inputSchema'],
  { properties: Record<string, unknown> }
>

export function extensionToolName(extensionId: string, toolName: string): string {
  return `${EXTENSION_TOOL_PREFIX}${extensionId}__${toolName}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeObjectInputSchema(schema: Record<string, unknown>): ObjectInputSchema {
  return {
    type: 'object',
    properties: isRecord(schema.properties) ? schema.properties : {},
    required: Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [],
    ...(typeof schema.additionalProperties === 'boolean'
      ? { additionalProperties: schema.additionalProperties }
      : {})
  }
}

function normalizeToolInputSchema(
  schema: Record<string, unknown>
): ToolHandler['definition']['inputSchema'] {
  if (Array.isArray(schema.oneOf)) {
    const oneOf = schema.oneOf
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => normalizeObjectInputSchema(item))
    if (oneOf.length > 0) {
      return {
        type: 'object',
        oneOf
      }
    }
  }
  return normalizeObjectInputSchema(schema)
}

function isReadOnlyTool(tool: ExtensionToolDefinition): boolean {
  if (typeof tool.readOnly === 'boolean') return tool.readOnly
  if (tool.kind === 'http') return (tool.http?.method ?? 'GET').toUpperCase() === 'GET'
  return false
}

function nativeOnlyExtensionResult(toolName: string): string {
  return encodeToolError(`${toolName} is not exposed by the Main TypeScript runtime boundary.`)
}

function createExtensionToolHandler(
  extension: ExtensionInstance,
  tool: ExtensionToolDefinition
): ToolHandler {
  return {
    definition: {
      name: extensionToolName(extension.id, tool.name),
      description: `[Extension: ${extension.manifest.name}] ${tool.description}`,
      inputSchema: normalizeToolInputSchema(tool.inputSchema)
    },
    execute: async () => nativeOnlyExtensionResult(extensionToolName(extension.id, tool.name)),
    requiresApproval: () => !isReadOnlyTool(tool)
  }
}

/** Build the request schema from the target session's project, not the foreground project. */
export function withRequestExtensionToolDefinitions(
  definitions: ToolDefinition[],
  projectId: string | null
): ToolDefinition[] {
  const activeExtensions = useExtensionStore.getState().getActiveExtensions(projectId)
  const extensionDefinitions = activeExtensions.flatMap((extension) =>
    extension.manifest.tools
      .filter((tool) => tool.kind === 'http')
      .map((tool) => createExtensionToolHandler(extension, tool).definition)
  )
  return [
    ...definitions.filter((definition) => !definition.name.startsWith(EXTENSION_TOOL_PREFIX)),
    ...extensionDefinitions
  ]
}

export function unregisterExtensionTools(): void {
  for (const name of registeredExtensionToolNames) {
    const extensionId = name.split('__')[1]
    if (extensionId) toolRegistry.unregister(name, `extension:${extensionId}`)
  }
  registeredExtensionToolNames = []
}

export async function refreshExtensionTools(): Promise<void> {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    await useExtensionStore.getState().loadExtensions()
    unregisterExtensionTools()

    const extensionStore = useExtensionStore.getState()
    const activeProjectId = useChatStore.getState().activeProjectId ?? null
    const activeExtensionIds = new Set(extensionStore.getActiveExtensionIds(activeProjectId))
    const names: string[] = []
    for (const extension of extensionStore.extensions) {
      if (!extension.enabled || !activeExtensionIds.has(extension.id)) continue
      for (const tool of extension.manifest.tools) {
        const handler = createExtensionToolHandler(extension, tool)
        toolRegistry.register(handler, {
          namespace: 'extension',
          owner: `extension:${extension.id}`,
          version: extension.manifest.version,
          capability: {
            readOnly: isReadOnlyTool(tool),
            riskLevel: isReadOnlyTool(tool) ? 'low' : 'medium',
            requiresApproval: !isReadOnlyTool(tool),
            projectScoped: true
          }
        })
        names.push(handler.definition.name)
      }
    }
    registeredExtensionToolNames = names
    await refreshExtensionWorkbenchContributions()
  })().finally(() => {
    refreshPromise = null
  })
  return refreshPromise
}

export function isExtensionToolsRegistered(): boolean {
  return registeredExtensionToolNames.length > 0
}
