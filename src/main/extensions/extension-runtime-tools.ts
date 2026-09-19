import type { ExtensionToolDefinition } from '../../shared/extension-types'
import type { ToolDefinition } from '../../runtime/tools/tool-executor'
import { executeExtensionHttpTool } from './extension-http-tool'
import type { ExtensionService, RuntimeExtension } from './extension-service'

const EXTENSION_TOOL_PREFIX = 'extension__'
const MAX_INPUT_BYTES = 128 * 1024

export function extensionRuntimeToolName(extensionId: string, toolName: string): string {
  return `${EXTENSION_TOOL_PREFIX}${extensionId}__${toolName}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isReadOnly(tool: ExtensionToolDefinition): boolean {
  if (typeof tool.readOnly === 'boolean') return tool.readOnly
  return (
    tool.kind === 'http' && ['GET', 'HEAD'].includes((tool.http?.method ?? 'GET').toUpperCase())
  )
}

function validateInput(input: unknown, schema: Record<string, unknown>): Record<string, unknown> {
  if (!isObject(input) || Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES)
    throw new Error('INVALID_TOOL_INPUT')
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : []
  if (required.some((key) => !Object.hasOwn(input, key))) throw new Error('INVALID_TOOL_INPUT')
  const properties = isObject(schema.properties) ? schema.properties : undefined
  if (schema.additionalProperties === false && properties) {
    if (Object.keys(input).some((key) => !Object.hasOwn(properties, key)))
      throw new Error('INVALID_TOOL_INPUT')
  }
  return input
}

function definition(
  extension: RuntimeExtension,
  tool: ExtensionToolDefinition
): ToolDefinition | null {
  if (tool.kind !== 'http') return null
  const name = extensionRuntimeToolName(extension.id, tool.name)
  return {
    name,
    description: `[Extension: ${extension.manifest.name}] ${tool.description}`,
    inputSchema: tool.inputSchema,
    effect: isReadOnly(tool) ? 'read' : 'write',
    validate: (input) => validateInput(input, tool.inputSchema),
    resources: async () => [`extension:${extension.id}:${tool.name}`],
    execute: async (input, context) =>
      await executeExtensionHttpTool({
        manifest: extension.manifest,
        enabled: extension.enabled,
        config: extension.config,
        toolName: tool.name,
        input: input as Record<string, unknown>,
        signal: context.signal
      })
  }
}

/**
 * Builds Main-owned declarative extension tools for the explicit run snapshot.
 * Disabled, missing, malformed and JS extensions are never exposed to the
 * model. Config comes from ExtensionService only at execution construction;
 * it must not be copied into RunSpec, events, or the renderer.
 */
export async function createExtensionRuntimeTools(
  service: Pick<ExtensionService, 'getRuntime'>,
  extensionIds: readonly string[] | undefined
): Promise<ToolDefinition[]> {
  const ids = [...new Set(extensionIds ?? [])]
  const extensions = await Promise.all(
    ids.map(async (id) => {
      try {
        return await service.getRuntime(id)
      } catch {
        return null
      }
    })
  )
  const names = new Set<string>()
  const result: ToolDefinition[] = []
  for (const extension of extensions) {
    if (!extension?.enabled) continue
    for (const tool of extension.manifest.tools) {
      const item = definition(extension, tool)
      if (!item || names.has(item.name)) continue
      names.add(item.name)
      result.push(item)
    }
  }
  return result
}
