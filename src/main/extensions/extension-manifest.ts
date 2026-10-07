import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ExtensionComponentDefinition,
  ExtensionConfigFieldSchema,
  ExtensionWorkbenchCommandDefinition,
  ExtensionWorkbenchViewDefinition,
  ExtensionHttpDefinition,
  ExtensionManifest,
  ExtensionRendererDefinition,
  ExtensionToolDefinition
} from '../../shared/extension-types'
import { extensionManifestPath, normalizeExtensionId } from './extension-paths'

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function optionalText(value: unknown): string | undefined {
  const result = text(value)
  return result || undefined
}

function objectValue(value: unknown): Record<string, unknown> {
  return object(value) ?? { type: 'object' }
}

function configSchema(value: unknown): ExtensionConfigFieldSchema[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const fields: ExtensionConfigFieldSchema[] = []
  for (const candidate of value) {
    const item = object(candidate)
    if (!item) continue
    const key = text(item.key)
    if (!key) continue
    if (seen.has(key)) throw new Error(`duplicate config key: ${key}`)
    seen.add(key)
    const field: ExtensionConfigFieldSchema = {
      key,
      label: text(item.label) || key,
      type: text(item.type) === 'secret' ? 'secret' : 'text'
    }
    if (typeof item.required === 'boolean') field.required = item.required
    for (const property of ['description', 'placeholder', 'defaultValue'] as const) {
      const result = optionalText(item[property])
      if (result) field[property] = result
    }
    fields.push(field)
  }
  return fields
}

function httpDefinition(toolName: string, value: unknown): ExtensionHttpDefinition {
  const item = object(value)
  const url = text(item?.url)
  if (!item || !url) throw new Error(`http tool "${toolName}" requires http.method and http.url`)
  const headers = Object.fromEntries(
    Object.entries(object(item.headers) ?? {}).flatMap(([key, header]) =>
      typeof header === 'string' ? [[key, header]] : []
    )
  )
  const result: ExtensionHttpDefinition = { method: text(item.method).toUpperCase() || 'GET', url }
  if (Object.keys(headers).length) result.headers = headers
  if (Object.hasOwn(item, 'body')) result.body = item.body
  return result
}

function artifactDefinition(value: unknown): ExtensionToolDefinition['artifact'] {
  if (value === undefined) return undefined
  const item = object(value)
  const urlPointer = text(item?.urlPointer)
  const titlePointer = optionalText(item?.titlePointer)
  const validPointer = (pointer: string): boolean =>
    pointer.length <= 256 && pointer.startsWith('/') && !pointer.includes('#')
  if (item?.kind !== 'link' || !validPointer(urlPointer))
    throw new Error('invalid extension artifact link declaration')
  if (titlePointer && !validPointer(titlePointer))
    throw new Error('invalid extension artifact link declaration')
  return { kind: 'link', urlPointer, ...(titlePointer ? { titlePointer } : {}) }
}

function tools(value: unknown): ExtensionToolDefinition[] {
  if (!Array.isArray(value)) throw new Error('extension must define at least one tool')
  const seen = new Set<string>()
  const result: ExtensionToolDefinition[] = []
  for (const candidate of value) {
    const item = object(candidate)
    if (!item) continue
    const name = text(item.name)
    if (!TOOL_NAME.test(name)) throw new Error('invalid extension tool name')
    if (seen.has(name)) throw new Error(`duplicate tool name: ${name}`)
    seen.add(name)
    const kind = text(item.kind)
    const definition: ExtensionToolDefinition = {
      name,
      description: optionalText(item.description) ?? name,
      inputSchema: objectValue(item.inputSchema),
      kind:
        kind === 'js' || kind === 'http'
          ? kind
          : (() => {
              throw new Error(`tool "${name}" kind must be "http" or "js"`)
            })()
    }
    if (typeof item.readOnly === 'boolean') definition.readOnly = item.readOnly
    if (item.artifact !== undefined) {
      if (definition.kind !== 'http') throw new Error(`tool "${name}" artifacts require HTTP`)
      definition.artifact = artifactDefinition(item.artifact)
    }
    if (definition.kind === 'js') {
      const handler = text(item.handler)
      if (!handler) throw new Error(`js tool "${name}" requires handler`)
      definition.handler = handler
    } else {
      definition.http = httpDefinition(name, item.http)
    }
    result.push(definition)
  }
  if (!result.length) throw new Error('extension must define at least one supported tool')
  return result
}

function networkPermissions(value: unknown): string[] | undefined {
  const network = object(value)?.network
  if (!Array.isArray(network)) return undefined
  const values = network.map(text).filter(Boolean)
  return values.length ? values : undefined
}

function renderers(value: unknown): ExtensionRendererDefinition[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const result = value.flatMap((candidate) => {
    const item = object(candidate)
    const name = text(item?.name)
    const entry = text(item?.entry)
    if (!name || !entry) return []
    if (seen.has(name)) throw new Error(`duplicate renderer name: ${name}`)
    seen.add(name)
    return [{ name, type: 'html' as const, entry }]
  })
  return result.length ? result : undefined
}

function components(value: unknown): ExtensionComponentDefinition[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const result = value.flatMap((candidate) => {
    const item = object(candidate)
    const name = text(item?.name)
    const entry = text(item?.entry)
    if (!name || !entry) return []
    if (seen.has(name)) throw new Error(`duplicate component name: ${name}`)
    seen.add(name)
    const result: ExtensionComponentDefinition = { name, type: 'html', entry }
    const title = optionalText(item?.title)
    const description = optionalText(item?.description)
    if (title) result.title = title
    if (description) result.description = description
    return [result]
  })
  return result.length ? result : undefined
}

function views(value: unknown): ExtensionWorkbenchViewDefinition[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const result = value.flatMap((candidate) => {
    const item = object(candidate)
    const name = text(item?.name)
    const entry = text(item?.entry)
    const title = text(item?.title)
    if (!TOOL_NAME.test(name) || !entry || !title || title.length > 128) return []
    if (seen.has(name)) throw new Error(`duplicate workbench view name: ${name}`)
    if (
      entry.startsWith('/') ||
      entry.includes('\\') ||
      entry.split('/').includes('..') ||
      !/^[A-Za-z0-9_./-]+\.html?$/i.test(entry)
    )
      throw new Error(`invalid workbench view entry: ${entry}`)
    seen.add(name)
    const view: ExtensionWorkbenchViewDefinition = { name, title, entry }
    const description = optionalText(item?.description)
    if (description) view.description = description
    return [view]
  })
  return result.length ? result : undefined
}

function commands(
  value: unknown,
  knownViews: ReadonlySet<string>
): ExtensionWorkbenchCommandDefinition[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const result = value.flatMap((candidate) => {
    const item = object(candidate)
    const name = text(item?.name)
    const title = text(item?.title)
    const view = text(item?.view)
    if (!TOOL_NAME.test(name) || !title || title.length > 128 || !view) return []
    if (seen.has(name)) throw new Error(`duplicate workbench command name: ${name}`)
    if (!knownViews.has(view)) throw new Error(`command "${name}" references an unknown view`)
    seen.add(name)
    const command: ExtensionWorkbenchCommandDefinition = { name, title, view }
    const description = optionalText(item?.description)
    if (description) command.description = description
    if (Array.isArray(item?.keywords)) {
      command.keywords = item.keywords
        .filter((keyword): keyword is string => typeof keyword === 'string')
        .map((keyword) => keyword.trim().slice(0, 80))
        .filter(Boolean)
    }
    return [command]
  })
  return result.length ? result : undefined
}

/** Parses and normalizes the version-1 manifest accepted by the legacy Worker. */
export function parseExtensionManifest(value: unknown, expectedId?: unknown): ExtensionManifest {
  const root = object(value)
  if (!root) throw new Error('extension.json must contain an object')
  if (root.schemaVersion !== 1) throw new Error('extension schemaVersion must be 1')
  const id = normalizeExtensionId(root.id)
  if (expectedId && id !== normalizeExtensionId(expectedId))
    throw new Error(`Extension "${id}" manifest id mismatch`)
  const name = text(root.name)
  const version = text(root.version)
  if (!name) throw new Error('extension name is required')
  if (!version) throw new Error('extension version is required')
  const manifestTools = tools(root.tools)
  const entry = optionalText(root.entry)
  if (manifestTools.some((tool) => tool.kind === 'js') && !entry)
    throw new Error('extension entry is required for js tools')
  const manifest: ExtensionManifest = { schemaVersion: 1, id, name, version, tools: manifestTools }
  const description = optionalText(root.description)
  const fields = configSchema(root.configSchema)
  const network = networkPermissions(root.permissions)
  const manifestRenderers = renderers(root.renderers)
  const manifestComponents = components(root.components)
  const manifestViews = views(root.views)
  const manifestCommands = commands(
    root.commands,
    new Set(manifestViews?.map((view) => view.name) ?? [])
  )
  if (description) manifest.description = description
  if (entry) manifest.entry = entry
  if (fields.length) manifest.configSchema = fields
  if (network) manifest.permissions = { network }
  if (manifestRenderers) manifest.renderers = manifestRenderers
  if (manifestComponents) manifest.components = manifestComponents
  if (manifestViews) manifest.views = manifestViews
  if (manifestCommands) manifest.commands = manifestCommands
  return manifest
}

export async function readExtensionManifest(
  extensionsDirectory: string,
  extensionId: unknown
): Promise<ExtensionManifest> {
  const id = normalizeExtensionId(extensionId)
  const contents = await readFile(extensionManifestPath(extensionsDirectory, id), 'utf8')
  return parseExtensionManifest(JSON.parse(contents) as unknown, id)
}

export async function readExtensionManifestFromDirectory(
  directory: string
): Promise<ExtensionManifest> {
  const contents = await readFile(join(directory, 'extension.json'), 'utf8')
  return parseExtensionManifest(JSON.parse(contents) as unknown)
}
