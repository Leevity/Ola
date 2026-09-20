import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, isAbsolute, relative, resolve } from 'node:path'

export interface AgentInfo {
  name: string
  description: string
  icon?: string
  tools: string[]
  allowedTools: string[]
  disallowedTools: string[]
  maxTurns: number
  maxIterations: number
  initialPrompt?: string
  background?: boolean
  model?: string
  temperature?: number
  systemPrompt: string
  profiles?: string[]
  category?: string
  tags?: string[]
  recommended?: boolean
  requiresProject?: boolean
  riskLevel?: string
  supportsBackground?: boolean
  runtimeOnly?: boolean
}

export interface AgentManageItem {
  id: string
  name: string
  description: string
  path: string
  source: 'user' | 'bundled' | 'overridden'
  editable: boolean
}

export type AgentManageReadResult = (AgentManageItem & { content: string }) | { error: string }
export type AgentMutationResult = { success: boolean; error?: string }

export interface AgentCatalogOptions {
  userDirectory: string
  bundledDirectoryCandidates: string[]
}

const DEFAULT_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'Bash']

function markdownFiles(directory: string): Promise<string[]> {
  return readdir(directory, { withFileTypes: true })
    .then((entries) =>
      entries
        .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.md')
        .map((entry) => resolve(directory, entry.name))
        .sort((left, right) =>
          basename(left).localeCompare(basename(right), undefined, { sensitivity: 'base' })
        )
    )
    .catch(() => [])
}

function isInsideDirectory(targetPath: string, directory: string): boolean {
  const relativePath = relative(resolve(directory), resolve(targetPath))
  return (
    Boolean(relativePath) &&
    relativePath !== '..' &&
    !relativePath.startsWith('../') &&
    !relativePath.startsWith('..\\') &&
    !isAbsolute(relativePath)
  )
}

function frontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.+)$`, 'm').exec(
    frontmatter
  )
  return match?.[1].trim().replace(/^(?:"|')|(?:"|')$/g, '') || undefined
}

function frontmatterList(frontmatter: string, key: string): string[] | undefined {
  const raw = frontmatterValue(frontmatter, key)
  if (!raw) return undefined
  const normalized = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  const values = normalized
    .split(',')
    .map((item) => item.trim().replace(/^(?:"|')|(?:"|')$/g, ''))
    .filter(Boolean)
  return values.length ? values : undefined
}

function frontmatterInteger(frontmatter: string, key: string): number | undefined {
  const value = frontmatterValue(frontmatter, key)
  return value && /^[+-]?\d+$/.test(value) ? Number.parseInt(value, 10) : undefined
}

function frontmatterNumber(frontmatter: string, key: string): number | undefined {
  const value = frontmatterValue(frontmatter, key)
  if (!value || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function frontmatterBoolean(frontmatter: string, key: string): boolean | undefined {
  const value = frontmatterValue(frontmatter, key)
  return value === 'true' ? true : value === 'false' ? false : undefined
}

function optional<T>(value: T | undefined, key: string): Record<string, T> {
  return value === undefined ? {} : ({ [key]: value } as Record<string, T>)
}

export function parseAgentMarkdown(content: string): AgentInfo | null {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!match) return null
  const frontmatter = match[1]
  const name = frontmatterValue(frontmatter, 'name')
  const description = frontmatterValue(frontmatter, 'description')
  if (!name || !description) return null
  const tools =
    frontmatterList(frontmatter, 'tools') ??
    frontmatterList(frontmatter, 'allowedTools') ??
    DEFAULT_TOOLS
  const maxTurns =
    frontmatterInteger(frontmatter, 'maxTurns') ??
    frontmatterInteger(frontmatter, 'maxIterations') ??
    0
  const body = content.slice(match[0].length).trimStart()
  return {
    name,
    description,
    tools,
    allowedTools: tools,
    disallowedTools: frontmatterList(frontmatter, 'disallowedTools') ?? [],
    maxTurns,
    maxIterations: maxTurns,
    systemPrompt: body || `You are ${name}, a specialized agent.`,
    ...optional(frontmatterValue(frontmatter, 'icon'), 'icon'),
    ...optional(frontmatterValue(frontmatter, 'initialPrompt'), 'initialPrompt'),
    ...optional(frontmatterBoolean(frontmatter, 'background'), 'background'),
    ...optional(frontmatterValue(frontmatter, 'model'), 'model'),
    ...optional(frontmatterNumber(frontmatter, 'temperature'), 'temperature'),
    ...optional(frontmatterList(frontmatter, 'profiles'), 'profiles'),
    ...optional(frontmatterValue(frontmatter, 'category'), 'category'),
    ...optional(frontmatterList(frontmatter, 'tags'), 'tags'),
    ...optional(frontmatterBoolean(frontmatter, 'recommended'), 'recommended'),
    ...optional(frontmatterBoolean(frontmatter, 'requiresProject'), 'requiresProject'),
    ...optional(frontmatterValue(frontmatter, 'riskLevel'), 'riskLevel'),
    ...optional(frontmatterBoolean(frontmatter, 'supportsBackground'), 'supportsBackground'),
    ...optional(frontmatterBoolean(frontmatter, 'runtimeOnly'), 'runtimeOnly')
  }
}

/** Main-owned agent file catalog. */
export class AgentCatalog {
  constructor(private readonly options: AgentCatalogOptions) {}

  private get bundledDirectory(): string {
    return (
      this.options.bundledDirectoryCandidates
        .map((candidate) => resolve(candidate))
        .find(existsSync) ?? resolve(this.options.bundledDirectoryCandidates[0] ?? 'agents')
    )
  }

  private get userDirectory(): string {
    return resolve(this.options.userDirectory)
  }

  async ensure(): Promise<{ success: boolean; error?: string }> {
    try {
      if (!existsSync(this.bundledDirectory)) return { success: true }
      await mkdir(this.userDirectory, { recursive: true })
      for (const sourcePath of await markdownFiles(this.bundledDirectory)) {
        const targetPath = resolve(this.userDirectory, basename(sourcePath))
        if (!existsSync(targetPath)) await copyFile(sourcePath, targetPath)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async list(): Promise<AgentInfo[]> {
    if (!(await this.ensure()).success) return []
    const result: AgentInfo[] = []
    for (const path of await markdownFiles(this.userDirectory)) {
      try {
        const agent = parseAgentMarkdown(await readFile(path, 'utf8'))
        if (agent) result.push(agent)
      } catch {
        // Match the legacy catalog: unreadable individual files are skipped.
      }
    }
    return result
  }

  async load(name: string): Promise<AgentInfo | { error: string }> {
    if (!(await this.ensure()).success) return { error: 'Agents directory not found' }
    for (const path of await markdownFiles(this.userDirectory)) {
      try {
        const agent = parseAgentMarkdown(await readFile(path, 'utf8'))
        if (agent?.name === name) return agent
      } catch {
        // Skip unreadable individual files.
      }
    }
    return { error: `Agent "${name}" not found` }
  }

  async manageList(): Promise<AgentManageItem[]> {
    if (!(await this.ensure()).success) return []
    const result: AgentManageItem[] = []
    for (const path of await markdownFiles(this.userDirectory)) {
      try {
        const agent = parseAgentMarkdown(await readFile(path, 'utf8'))
        if (!agent) continue
        const source = await this.managedSource(path)
        result.push({
          id: path,
          name: agent.name,
          description: agent.description,
          path,
          source: source.source,
          editable: source.editable
        })
      } catch {
        // Skip unreadable individual files.
      }
    }
    return result.sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
    )
  }

  async manageRead(path: string): Promise<AgentManageReadResult> {
    try {
      const targetPath = path.trim()
      if (!targetPath) return { error: 'Agent path is required' }
      if (!isInsideDirectory(targetPath, this.userDirectory)) {
        return { error: 'Agent path is outside the managed directory' }
      }
      if (!existsSync(targetPath)) return { error: `Agent file not found: ${targetPath}` }
      const content = await readFile(targetPath, 'utf8')
      const agent = parseAgentMarkdown(content)
      if (!agent) return { error: `Agent file is invalid: ${targetPath}` }
      const source = await this.managedSource(targetPath)
      return {
        id: resolve(targetPath),
        name: agent.name,
        description: agent.description,
        path: resolve(targetPath),
        source: source.source,
        editable: source.editable,
        content
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  async manageSave(input: { path: string; content: string }): Promise<AgentMutationResult> {
    try {
      const targetPath = input.path.trim()
      if (!targetPath) return { success: false, error: 'Agent path is required' }
      if (!isInsideDirectory(targetPath, this.userDirectory)) {
        return { success: false, error: 'Agent path is outside the managed directory' }
      }
      if (!parseAgentMarkdown(input.content)) {
        return {
          success: false,
          error: 'Agent markdown is invalid or missing required frontmatter'
        }
      }
      await writeFile(resolve(targetPath), input.content, 'utf8')
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async managedSource(
    path: string
  ): Promise<{ source: AgentManageItem['source']; editable: boolean }> {
    const bundledPath = resolve(this.bundledDirectory, basename(path))
    if (!existsSync(bundledPath)) return { source: 'user', editable: true }
    const same = (await readFile(path, 'utf8')) === (await readFile(bundledPath, 'utf8'))
    return same ? { source: 'bundled', editable: false } : { source: 'overridden', editable: true }
  }
}
