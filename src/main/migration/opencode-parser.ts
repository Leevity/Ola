import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { globSync } from 'glob'
import type {
  OpenCodeInstructionsSource,
  OpenCodeSourceAgent,
  OpenCodeSourceCommand,
  OpenCodeSourceMcp,
  OpenCodeSourceModel,
  OpenCodeSourceProvider,
  ParsedOpenCodeConfig
} from './types'

const OPENCODE_CONFIG_PATH = path.join(os.homedir(), '.config', 'opencode', 'opencode.json')

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripJsonComments(input: string): string {
  let result = ''
  let inString = false
  let stringQuote = ''
  let escaping = false
  let inLineComment = false
  let inBlockComment = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false
        result += char
      }
      continue
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        index += 1
      }
      continue
    }

    if (inString) {
      result += char
      if (escaping) {
        escaping = false
        continue
      }
      if (char === '\\') {
        escaping = true
        continue
      }
      if (char === stringQuote) {
        inString = false
        stringQuote = ''
      }
      continue
    }

    if ((char === '"' || char === "'") && !inString) {
      inString = true
      stringQuote = char
      result += char
      continue
    }

    if (char === '/' && next === '/') {
      inLineComment = true
      index += 1
      continue
    }

    if (char === '/' && next === '*') {
      inBlockComment = true
      index += 1
      continue
    }

    result += char
  }

  return result
}

function removeTrailingCommas(input: string): string {
  let result = ''
  let inString = false
  let stringQuote = ''
  let escaping = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]

    if (inString) {
      result += char
      if (escaping) {
        escaping = false
        continue
      }
      if (char === '\\') {
        escaping = true
        continue
      }
      if (char === stringQuote) {
        inString = false
        stringQuote = ''
      }
      continue
    }

    if (char === '"' || char === "'") {
      inString = true
      stringQuote = char
      result += char
      continue
    }

    if (char === ',') {
      let lookAhead = index + 1
      while (lookAhead < input.length && /\s/.test(input[lookAhead])) {
        lookAhead += 1
      }
      if (input[lookAhead] === '}' || input[lookAhead] === ']') {
        continue
      }
    }

    result += char
  }

  return result
}

function normalizeJsonLike(input: string): string {
  const withoutBom = input.replace(/^\uFEFF/, '')
  return removeTrailingCommas(stripJsonComments(withoutBom))
}

function replaceEnvTokens(input: string, warnings: string[], contextLabel: string): string {
  return input.replace(/\{env:([^}]+)\}/g, (_match, rawName: string) => {
    const envName = rawName.trim()
    const envValue = process.env[envName]
    if (envValue === undefined) {
      warnings.push(`Environment variable ${envName} not set: ${contextLabel}`)
      return ''
    }
    return envValue
  })
}

function resolveEnvTemplates(value: unknown, warnings: string[], contextLabel: string): unknown {
  if (typeof value === 'string') {
    return replaceEnvTokens(value, warnings, contextLabel)
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      resolveEnvTemplates(entry, warnings, `${contextLabel}[${index}]`)
    )
  }

  if (isPlainObject(value)) {
    const next: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      next[key] = resolveEnvTemplates(entry, warnings, `${contextLabel}.${key}`)
    }
    return next
  }

  return value
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function toOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  }

  return []
}

function extractAgentTools(value: unknown): string[] | undefined {
  if (Array.isArray(value) || typeof value === 'string') {
    const tools = toStringArray(value)
    return tools.length > 0 ? tools : undefined
  }

  if (isPlainObject(value)) {
    const tools = Object.entries(value)
      .filter(([, enabled]) => enabled === true)
      .map(([toolName]) => toolName.trim())
      .filter(Boolean)
    return tools.length > 0 ? tools : undefined
  }

  return undefined
}

function normalizeSourceModel(key: string, value: unknown): OpenCodeSourceModel | null {
  if (!isPlainObject(value)) return null

  const rawCost = isPlainObject(value.cost) ? value.cost : {}
  const rawLimit = isPlainObject(value.limit) ? value.limit : {}
  const rawModalities = isPlainObject(value.modalities) ? value.modalities : {}

  return {
    id: toOptionalString(value.id) ?? key,
    name: toOptionalString(value.name),
    family: toOptionalString(value.family),
    releaseDate: toOptionalString(value.release_date),
    attachment: toOptionalBoolean(value.attachment),
    reasoning: toOptionalBoolean(value.reasoning),
    temperature: toOptionalBoolean(value.temperature),
    toolCall: toOptionalBoolean(value.tool_call),
    modalities: {
      input: toStringArray(rawModalities.input),
      output: toStringArray(rawModalities.output)
    },
    cost: {
      input: toOptionalNumber(rawCost.input),
      output: toOptionalNumber(rawCost.output),
      cacheRead: toOptionalNumber(rawCost.cache_read),
      cacheWrite: toOptionalNumber(rawCost.cache_write)
    },
    limit: {
      context: toOptionalNumber(rawLimit.context),
      input: toOptionalNumber(rawLimit.input),
      output: toOptionalNumber(rawLimit.output)
    },
    raw: value
  }
}

function normalizeProvider(key: string, value: unknown): OpenCodeSourceProvider | null {
  if (!isPlainObject(value)) return null

  const modelsRecord = isPlainObject(value.models) ? value.models : {}
  const models = Object.entries(modelsRecord)
    .map(([modelKey, modelValue]) => normalizeSourceModel(modelKey, modelValue))
    .filter((model): model is OpenCodeSourceModel => Boolean(model))

  return {
    key,
    name: toOptionalString(value.name) ?? key,
    npm: toOptionalString(value.npm),
    api: toOptionalString(value.api),
    id: toOptionalString(value.id),
    env: toStringArray(value.env),
    options: isPlainObject(value.options) ? value.options : {},
    models,
    raw: value
  }
}

function normalizeCommand(key: string, value: unknown): OpenCodeSourceCommand | null {
  if (!isPlainObject(value)) return null
  const template = toOptionalString(value.template)
  if (!template) return null

  return {
    key,
    description: toOptionalString(value.description),
    template,
    model: toOptionalString(value.model),
    agent: toOptionalString(value.agent),
    subtask: toOptionalBoolean(value.subtask),
    raw: value
  }
}

function normalizeAgent(key: string, value: unknown): OpenCodeSourceAgent | null {
  if (!isPlainObject(value)) return null
  const prompt = toOptionalString(value.prompt)
  if (!prompt) return null

  const unsupportedFields = Object.keys(value).filter(
    (field) =>
      !['description', 'prompt', 'steps', 'tools', 'permission', 'model', 'temperature'].includes(
        field
      )
  )

  return {
    key,
    description: toOptionalString(value.description),
    prompt,
    steps: toOptionalNumber(value.steps),
    tools: extractAgentTools(value.tools),
    permission:
      isPlainObject(value.permission) || typeof value.permission === 'string'
        ? value.permission
        : undefined,
    model: toOptionalString(value.model),
    temperature: toOptionalNumber(value.temperature),
    mode: toOptionalString(value.mode),
    variant: toOptionalString(value.variant),
    unsupportedFields,
    raw: value
  }
}

function normalizeMcpServer(key: string, value: unknown): OpenCodeSourceMcp | null {
  if (!isPlainObject(value)) return null

  return {
    key,
    type: value.type === 'local' || value.type === 'remote' ? value.type : undefined,
    enabled: toOptionalBoolean(value.enabled),
    command: toStringArray(value.command),
    environment: isPlainObject(value.environment)
      ? Object.fromEntries(
          Object.entries(value.environment)
            .filter(([, entry]) => typeof entry === 'string')
            .map(([envKey, entry]) => [envKey, String(entry)])
        )
      : undefined,
    url: toOptionalString(value.url),
    headers: isPlainObject(value.headers)
      ? Object.fromEntries(
          Object.entries(value.headers)
            .filter(([, entry]) => typeof entry === 'string')
            .map(([headerKey, entry]) => [headerKey, String(entry)])
        )
      : undefined,
    timeout: toOptionalNumber(value.timeout),
    oauth:
      isPlainObject(value.oauth) || value.oauth === false
        ? (value.oauth as Record<string, unknown> | false)
        : undefined,
    raw: value
  }
}

function isGlobPattern(input: string): boolean {
  return /[*?[\]{}]/.test(input)
}

function normalizeAbsoluteGlobPattern(input: string): string {
  return input.replace(/\\/g, '/')
}

function buildManagedInstructionsContent(
  files: Array<{ source: string; path: string; content: string }>
): string {
  if (files.length === 0) return ''

  return files
    .map((file) => `### Source: ${file.source}\nPath: ${file.path}\n\n${file.content.trim()}`)
    .join('\n\n---\n\n')
}

function resolveInstructions(
  entries: string[],
  sourceDir: string,
  warnings: string[]
): OpenCodeInstructionsSource {
  const resolvedFiles: Array<{ source: string; path: string; content: string }> = []
  const unresolved: Array<{ source: string; reason: string }> = []
  const seen = new Set<string>()

  for (const rawEntry of entries) {
    const entry = rawEntry.trim()
    if (!entry) continue

    const matches = isGlobPattern(entry)
      ? globSync(path.isAbsolute(entry) ? normalizeAbsoluteGlobPattern(entry) : entry, {
          cwd: sourceDir,
          absolute: true,
          nodir: true,
          windowsPathsNoEscape: true
        })
      : [path.isAbsolute(entry) ? entry : path.resolve(sourceDir, entry)]

    const existingMatches = matches.filter(
      (filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    )

    if (existingMatches.length === 0) {
      unresolved.push({
        source: entry,
        reason: 'No readable files found'
      })
      continue
    }

    for (const filePath of existingMatches) {
      const normalizedKey = path.normalize(filePath).toLowerCase()
      if (seen.has(normalizedKey)) continue
      seen.add(normalizedKey)

      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        resolvedFiles.push({ source: entry, path: filePath, content })
      } catch (error) {
        unresolved.push({
          source: entry,
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  for (const item of unresolved) {
    warnings.push(`Cannot read instructions: ${item.source} (${item.reason})`)
  }

  return {
    entries,
    resolvedFiles,
    unresolved,
    managedContent: buildManagedInstructionsContent(resolvedFiles)
  }
}

function createEmptyParsedConfig(): ParsedOpenCodeConfig {
  const sourcePath = OPENCODE_CONFIG_PATH
  return {
    sourcePath,
    sourceDir: path.dirname(sourcePath),
    exists: false,
    warnings: [],
    providers: [],
    commands: [],
    agents: [],
    mcpServers: [],
    instructions: {
      entries: [],
      resolvedFiles: [],
      unresolved: [],
      managedContent: ''
    }
  }
}

export function getOpenCodeConfigPath(): string {
  return OPENCODE_CONFIG_PATH
}

export function parseOpenCodeConfig(): ParsedOpenCodeConfig {
  const initial = createEmptyParsedConfig()
  if (!fs.existsSync(initial.sourcePath)) {
    initial.warnings.push('No OpenCode configuration file detected')
    return initial
  }

  initial.exists = true

  try {
    const rawText = fs.readFileSync(initial.sourcePath, 'utf-8')
    const normalizedText = normalizeJsonLike(rawText)
    const parsed = JSON.parse(normalizedText) as unknown
    const resolved = resolveEnvTemplates(parsed, initial.warnings, 'opencode.json')

    if (!isPlainObject(resolved)) {
      initial.warnings.push('OpenCode configuration root node is not an object')
      return initial
    }

    const providers = isPlainObject(resolved.provider) ? resolved.provider : {}
    const commands = isPlainObject(resolved.command) ? resolved.command : {}
    const agents = isPlainObject(resolved.agent) ? resolved.agent : {}
    const mcpServers = isPlainObject(resolved.mcp) ? resolved.mcp : {}
    const instructionEntries = toStringArray(resolved.instructions)

    initial.providers = Object.entries(providers)
      .map(([key, value]) => normalizeProvider(key, value))
      .filter((provider): provider is OpenCodeSourceProvider => Boolean(provider))

    initial.commands = Object.entries(commands)
      .map(([key, value]) => normalizeCommand(key, value))
      .filter((command): command is OpenCodeSourceCommand => Boolean(command))

    initial.agents = Object.entries(agents)
      .map(([key, value]) => normalizeAgent(key, value))
      .filter((agent): agent is OpenCodeSourceAgent => Boolean(agent))

    initial.mcpServers = Object.entries(mcpServers)
      .map(([key, value]) => normalizeMcpServer(key, value))
      .filter((server): server is OpenCodeSourceMcp => Boolean(server))

    initial.instructions = resolveInstructions(
      instructionEntries,
      initial.sourceDir,
      initial.warnings
    )
    initial.model = toOptionalString(resolved.model)
    initial.smallModel = toOptionalString(resolved.small_model)
    return initial
  } catch (error) {
    initial.warnings.push(error instanceof Error ? error.message : String(error))
    return initial
  }
}
