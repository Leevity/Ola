import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path'

export interface CommandInfo {
  name: string
  summary: string
}

export interface CommandManageItem extends CommandInfo {
  id: string
  path: string
  source: 'bundled' | 'user'
  editable: boolean
  effective: boolean
}

export type CommandLoadResult =
  | { name: string; content: string; summary: string }
  | { error: string; notFound?: boolean }

export type CommandManageReadResult = (CommandManageItem & { content: string }) | { error: string }
export type CommandMutationResult = { success: boolean; path?: string; error?: string }

export interface CommandCatalogOptions {
  userDirectory: string
  bundledDirectoryCandidates: string[]
}

function resolvedDirectory(directory: string): string {
  return resolve(directory)
}

function isInsideDirectory(targetPath: string, directory: string): boolean {
  const relativePath = relative(resolvedDirectory(directory), resolve(targetPath))
  return (
    Boolean(relativePath) &&
    relativePath !== '..' &&
    !relativePath.startsWith('../') &&
    !relativePath.startsWith('..\\') &&
    !isAbsolute(relativePath)
  )
}

async function markdownFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.md')
      .map((entry) => resolve(directory, entry.name))
      .sort((left, right) =>
        basename(left).localeCompare(basename(right), undefined, { sensitivity: 'base' })
      )
  } catch {
    return []
  }
}

function commandNameFromFilename(filename: string): string {
  return extname(filename).toLowerCase() === '.md'
    ? basename(filename, extname(filename))
    : basename(filename)
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

function summarize(content: string): string {
  const line = content
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith('```'))
  if (!line) return ''
  const normalized = line.replace(/^#+\s*/, '').trim()
  return normalized.length > 120 ? `${normalized.slice(0, 120)}…` : normalized
}

function validateName(name: string): string | null {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name.trim())
    ? null
    : 'Command name must be kebab-case (lowercase letters, numbers, hyphens)'
}

function validateContent(content: string): string | null {
  const normalized = content.replace(/\r\n/g, '\n').trim()
  if (!normalized) return 'Command content cannot be empty'
  if (/^---\s*\n/.test(normalized)) {
    return 'Commands must be plain Markdown without YAML frontmatter'
  }
  if (/<\/?system-command\b/i.test(normalized)) {
    return 'Commands cannot contain <system-command> tags'
  }
  return normalized
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line && !line.startsWith('```'))
    ? null
    : 'Command markdown must include at least one non-code text line'
}

function newCommandTemplate(name: string): string {
  return `Describe what /${name} should make the agent do.\n\n- Goal:\n- Constraints:\n- Output format:`
}

/**
 * Main-owned command catalog. It deliberately receives explicit directories so
 * the production host and isolated contract tests never need to share a user
 * data path. Bundled commands win duplicate names, matching the legacy worker.
 */
export class CommandCatalog {
  constructor(private readonly options: CommandCatalogOptions) {}

  private get bundledDirectory(): string {
    return (
      this.options.bundledDirectoryCandidates.map(resolvedDirectory).find(existsSync) ??
      resolvedDirectory(this.options.bundledDirectoryCandidates[0] ?? 'commands')
    )
  }

  private get userDirectory(): string {
    return resolvedDirectory(this.options.userDirectory)
  }

  async ensure(): Promise<void> {
    await mkdir(this.userDirectory, { recursive: true })
  }

  async list(): Promise<CommandInfo[]> {
    try {
      const byName = new Map<string, CommandInfo>()
      for (const directory of [this.bundledDirectory, this.userDirectory]) {
        for (const path of await markdownFiles(directory)) {
          const name = commandNameFromFilename(path)
          const normalized = normalizeName(name)
          if (byName.has(normalized)) continue
          byName.set(normalized, { name, summary: summarize(await readFile(path, 'utf8')) })
        }
      }
      return [...byName.values()].sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
      )
    } catch {
      return []
    }
  }

  async load(name: string): Promise<CommandLoadResult> {
    try {
      const normalizedName = name.trim()
      if (!normalizedName) return { error: 'Command name is required' }
      const path = await this.resolveCommandPath(normalizedName)
      if (!path) return { error: `Command "${normalizedName}" not found`, notFound: true }
      const content = (await readFile(path, 'utf8')).trim()
      if (!content) return { error: `Command "${normalizedName}" is empty` }
      return { name: commandNameFromFilename(path), content, summary: summarize(content) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  async manageList(): Promise<CommandManageItem[]> {
    try {
      const effectiveNames = new Set<string>()
      const result: CommandManageItem[] = []
      for (const source of [
        { directory: this.bundledDirectory, source: 'bundled' as const, editable: false },
        { directory: this.userDirectory, source: 'user' as const, editable: true }
      ]) {
        for (const path of await markdownFiles(source.directory)) {
          const name = commandNameFromFilename(path)
          const normalized = normalizeName(name)
          const effective = !effectiveNames.has(normalized)
          if (effective) effectiveNames.add(normalized)
          const content = await readFile(path, 'utf8')
          result.push({
            id: `${source.source}:${path}`,
            name,
            summary: summarize(content),
            path,
            source: source.source,
            editable: source.editable,
            effective
          })
        }
      }
      return result.sort(
        (left, right) =>
          left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) ||
          (left.source === 'bundled' ? -1 : 1)
      )
    } catch {
      return []
    }
  }

  async manageRead(path: string): Promise<CommandManageReadResult> {
    try {
      const targetPath = path.trim()
      if (!targetPath) return { error: 'Command path is required' }
      const bundled = isInsideDirectory(targetPath, this.bundledDirectory)
      const user = isInsideDirectory(targetPath, this.userDirectory)
      if (!bundled && !user) return { error: 'Command path is outside the managed directories' }
      if (!existsSync(targetPath)) return { error: `Command file not found: ${targetPath}` }
      const content = await readFile(targetPath, 'utf8')
      const name = commandNameFromFilename(targetPath)
      const source = bundled ? 'bundled' : 'user'
      return {
        id: `${source}:${resolve(targetPath)}`,
        name,
        summary: summarize(content),
        path: resolve(targetPath),
        source,
        editable: source === 'user',
        effective: (await this.resolveCommandPath(name)) === resolve(targetPath),
        content
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  async manageCreate(input: { name: string; content?: string }): Promise<CommandMutationResult> {
    try {
      const name = input.name.trim()
      if (!name) return { success: false, error: 'Command name is required' }
      const nameError = validateName(name)
      if (nameError) return { success: false, error: nameError }
      await this.ensure()
      const path = resolve(this.userDirectory, `${name}.md`)
      if (existsSync(path)) return { success: false, error: `Command "${name}" already exists` }
      const content = input.content?.trim() || newCommandTemplate(name)
      const contentError = validateContent(content)
      if (contentError) return { success: false, error: contentError }
      await writeFile(path, content, { encoding: 'utf8', flag: 'wx' })
      return { success: true, path }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async manageSave(input: { path: string; content: string }): Promise<CommandMutationResult> {
    try {
      const targetPath = input.path.trim()
      if (!targetPath) return { success: false, error: 'Command path is required' }
      if (!isInsideDirectory(targetPath, this.userDirectory)) {
        return { success: false, error: 'Only user commands can be edited' }
      }
      const contentError = validateContent(input.content)
      if (contentError) return { success: false, error: contentError }
      const resolvedTarget = resolve(targetPath)
      await mkdir(dirname(resolvedTarget), { recursive: true })
      await writeFile(resolvedTarget, input.content, 'utf8')
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async resolveCommandPath(name: string): Promise<string | null> {
    const normalized = normalizeName(name)
    if (!normalized) return null
    for (const directory of [this.bundledDirectory, this.userDirectory]) {
      for (const path of await markdownFiles(directory)) {
        if (normalizeName(commandNameFromFilename(path)) === normalized) return path
      }
    }
    return null
  }
}
