import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, join, relative, resolve, sep } from 'node:path'

const SKILL_FILE = 'SKILL.md'
const BUILTIN_MARKER = '.ola-builtin.json'
const MAX_INSTRUCTION_LINES = 500
const SKILL_NAME = /^[a-z0-9-]+$/

export interface SkillCatalogOptions {
  homeDirectory: string
  bundledDirectoryCandidates: string[]
}

export interface SkillInfo {
  name: string
  description: string
}

export interface SkillFileInfo {
  name: string
  size: number
  type: string
}

export class SkillCatalog {
  private readonly root: string

  constructor(private readonly options: SkillCatalogOptions) {
    this.root = resolve(options.homeDirectory, '.agents', 'skills')
  }

  async ensureBuiltins(): Promise<{ success: boolean; error?: string }> {
    try {
      const bundled = await this.bundledDirectory()
      if (!bundled) return { success: true }
      await mkdir(this.root, { recursive: true })
      for (const entry of await readdir(bundled, { withFileTypes: true })) {
        if (!entry.isDirectory() || !isSafeSkillName(entry.name)) continue
        const source = join(bundled, entry.name)
        const manifest = await readOptional(join(source, SKILL_FILE))
        if (!manifest || validateSkillManifest(manifest, entry.name)) continue
        await this.synchronizeBuiltin(source, this.pathFor(entry.name), entry.name)
      }
      return { success: true }
    } catch (error) {
      return failure(error)
    }
  }

  async ensureBuiltin(name: string): Promise<{ success: boolean; name?: string; error?: string }> {
    if (!SKILL_NAME.test(name)) return { success: false, error: 'Invalid built-in skill name' }
    try {
      const bundled = await this.bundledDirectory()
      if (!bundled) return { success: false, error: 'Bundled skills directory not found' }
      const source = join(bundled, name)
      const manifest = await readOptional(join(source, SKILL_FILE))
      if (!manifest) return { success: false, error: `Built-in skill "${name}" was not found` }
      const manifestError = validateSkillManifest(manifest, name)
      if (manifestError) return { success: false, error: manifestError }
      await mkdir(this.root, { recursive: true })
      await this.synchronizeBuiltin(source, this.pathFor(name), name)
      return { success: true, name }
    } catch (error) {
      return failure(error)
    }
  }

  async list(): Promise<SkillInfo[]> {
    const initialized = await this.ensureBuiltins()
    if (!initialized.success) return []
    try {
      const entries = await readdir(this.root, { withFileTypes: true })
      const skills = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const content = await readOptional(join(this.root, entry.name, SKILL_FILE))
            return content
              ? { name: entry.name, description: extractSkillDescription(content, entry.name) }
              : null
          })
      )
      return skills.filter((skill): skill is SkillInfo => skill !== null).sort(byName)
    } catch {
      return []
    }
  }

  async load(
    name: string
  ): Promise<{ content: string; workingDirectory: string } | { error: string }> {
    try {
      const directory = this.pathFor(name)
      const content = await readOptional(join(directory, SKILL_FILE))
      return content
        ? { content: stripFrontmatter(content).trimStart(), workingDirectory: directory }
        : { error: `Skill "${name}" not found at ${join(directory, SKILL_FILE)}` }
    } catch (error) {
      return { error: errorMessage(error) }
    }
  }

  async read(name: string): Promise<{ content: string } | { error: string }> {
    try {
      const content = await readOptional(join(this.pathFor(name), SKILL_FILE))
      return content ? { content } : { error: `Skill "${name}" not found` }
    } catch (error) {
      return { error: errorMessage(error) }
    }
  }

  async listFiles(name: string): Promise<{ files: SkillFileInfo[] } | { error: string }> {
    try {
      const directory = this.pathFor(name)
      if (!(await isDirectory(directory))) return { error: `Skill "${name}" not found` }
      return { files: await listFiles(directory) }
    } catch (error) {
      return { error: errorMessage(error) }
    }
  }

  async delete(name: string): Promise<{ success: boolean; error?: string }> {
    try {
      const directory = this.pathFor(name)
      if (!(await isDirectory(directory)))
        return { success: false, error: `Skill "${name}" not found` }
      await rm(directory, { recursive: true, force: false })
      return { success: true }
    } catch (error) {
      return failure(error)
    }
  }

  async resolvePath(name: string): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      const directory = this.pathFor(name)
      return (await isDirectory(directory))
        ? { success: true, path: directory }
        : { success: false, error: `Skill "${name}" not found` }
    } catch (error) {
      return failure(error)
    }
  }

  async addFromFolder(
    sourcePath: string
  ): Promise<{ success: boolean; name?: string; error?: string }> {
    try {
      const source = resolve(sourcePath)
      const name = basename(source)
      if (!(await isDirectory(source)) || !(await readOptional(join(source, SKILL_FILE)))) {
        return { success: false, error: `No ${SKILL_FILE} found in the selected folder` }
      }
      if (!isSafeSkillName(name)) return { success: false, error: 'Invalid skill folder name' }
      const content = await readFile(join(source, SKILL_FILE), 'utf8')
      const manifestError = validateSkillManifest(content, name)
      if (manifestError) return { success: false, error: manifestError }
      const target = this.pathFor(name)
      if (await isDirectory(target))
        return { success: false, error: `Skill "${name}" already exists` }
      await mkdir(this.root, { recursive: true })
      await copyDirectory(source, target)
      return { success: true, name }
    } catch (error) {
      return failure(error)
    }
  }

  async save(name: string, content: string): Promise<{ success: boolean; error?: string }> {
    try {
      const directory = this.pathFor(name)
      if (!(await isDirectory(directory)))
        return { success: false, error: `Skill "${name}" not found` }
      const manifestError = validateSkillManifest(content, name)
      if (manifestError) return { success: false, error: manifestError }
      const manifest = join(directory, SKILL_FILE)
      const temporary = `${manifest}.tmp-${randomUUID()}`
      await writeFile(temporary, content, 'utf8')
      await rename(temporary, manifest)
      return { success: true }
    } catch (error) {
      return failure(error)
    }
  }

  private pathFor(name: string): string {
    if (!isSafeSkillName(name)) throw new Error('Invalid skill name')
    const target = resolve(this.root, name)
    if (!target.startsWith(`${this.root}${sep}`)) throw new Error('Path escapes skills directory')
    return target
  }

  private async bundledDirectory(): Promise<string | undefined> {
    for (const candidate of this.options.bundledDirectoryCandidates) {
      const path = resolve(candidate)
      if (await isDirectory(path)) return path
    }
    return undefined
  }

  private async synchronizeBuiltin(source: string, target: string, name: string): Promise<void> {
    const sourceHash = await directoryHash(source)
    if (!(await isDirectory(target))) {
      await copyDirectory(source, target)
      await writeMarker(target, name, sourceHash)
      return
    }
    const marker = await readMarker(join(target, BUILTIN_MARKER))
    if (!marker) {
      if ((await directoryHash(target)) === sourceHash) await writeMarker(target, name, sourceHash)
      return
    }
    if (marker.sourceHash === sourceHash || (await directoryHash(target)) !== marker.sourceHash)
      return
    await replaceDirectory(source, target, name, sourceHash)
  }
}

function isSafeSkillName(name: string): boolean {
  return (
    Boolean(name.trim()) &&
    !name.includes('/') &&
    !name.includes('\\') &&
    name !== '.' &&
    name !== '..'
  )
}

function byName(left: SkillInfo, right: SkillInfo): number {
  return left.name.localeCompare(right.name)
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

function failure(error: unknown): { success: false; error: string } {
  return { success: false, error: errorMessage(error) }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n)?/, '')
}

export function extractSkillDescription(content: string, fallback: string): string {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)
  const description = match?.[1]
    .match(/^description:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, '')
  if (description) return description.length > 200 ? `${description.slice(0, 200)}...` : description
  const body = stripFrontmatter(content)
  const first = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'))
  return first ? (first.length > 120 ? `${first.slice(0, 120)}...` : first) : fallback
}

export function validateSkillManifest(content: string, expectedName: string): string | undefined {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return 'SKILL.md must start with YAML frontmatter'
  const values = new Map<string, string>()
  let multiline: string | undefined
  for (const raw of match[1].split('\n')) {
    const indented = /^\s/.test(raw)
    const line = raw.trim()
    if (multiline && indented && line) {
      values.set(multiline, [values.get(multiline), line].filter(Boolean).join(' '))
      continue
    }
    multiline = undefined
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator <= 0) return `Invalid SKILL.md frontmatter line: ${line}`
    const key = line.slice(0, separator).trim()
    if (key !== 'name' && key !== 'description')
      return `Unsupported SKILL.md frontmatter field: ${key}`
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
    values.set(key, value === '>' || value === '|' ? '' : value)
    if (value === '>' || value === '|') multiline = key
  }
  const name = values.get('name')
  if (!name || !SKILL_NAME.test(name))
    return 'SKILL.md name must use lowercase letters, digits, and hyphens'
  if (name !== expectedName) return `SKILL.md name "${name}" must match folder "${expectedName}"`
  const description = values.get('description')?.trim()
  if (!description) return 'SKILL.md description is required'
  if (description.length > 1024) return 'SKILL.md description must not exceed 1024 characters'
  return stripFrontmatter(content).replace(/\r\n?/g, '\n').split('\n').length >
    MAX_INSTRUCTION_LINES
    ? `SKILL.md instructions must not exceed ${MAX_INSTRUCTION_LINES} lines`
    : undefined
}

async function listFiles(root: string): Promise<SkillFileInfo[]> {
  const results: SkillFileInfo[] = []
  for (const path of await walkFiles(root)) {
    const file = await stat(path)
    const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
    results.push({
      name: relative(root, path).split(sep).join('/'),
      size: file.size,
      type: extension || 'unknown'
    })
  }
  return results.sort((left, right) => left.name.localeCompare(right.name))
}

async function walkFiles(root: string): Promise<string[]> {
  const results: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) results.push(...(await walkFiles(path)))
    else if (info.isFile()) results.push(path)
  }
  return results
}

async function copyDirectory(source: string, target: string): Promise<void> {
  for (const path of await walkFiles(source)) {
    const destination = resolve(target, relative(source, path))
    if (!destination.startsWith(`${resolve(target)}${sep}`))
      throw new Error('Skill source path escapes target')
    await mkdir(join(destination, '..'), { recursive: true })
    await cp(path, destination, { force: true })
  }
}

async function directoryHash(root: string): Promise<string> {
  const hash = createHash('sha256')
  for (const path of await walkFiles(root)) {
    const name = relative(root, path).split(sep).join('/')
    if (name === BUILTIN_MARKER) continue
    hash.update(`${name}\n`)
    hash.update(await readFile(path))
  }
  return hash.digest('hex')
}

async function readMarker(path: string): Promise<{ sourceHash: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { sourceHash?: unknown }
    return typeof value.sourceHash === 'string' ? { sourceHash: value.sourceHash } : undefined
  } catch {
    return undefined
  }
}

async function writeMarker(path: string, name: string, sourceHash: string): Promise<void> {
  await writeFile(join(path, BUILTIN_MARKER), JSON.stringify({ name, sourceHash }), 'utf8')
}

async function replaceDirectory(
  source: string,
  target: string,
  name: string,
  sourceHash: string
): Promise<void> {
  const staging = `${target}.update-${randomUUID()}`
  const previous = `${target}.previous-${randomUUID()}`
  await copyDirectory(source, staging)
  await writeMarker(staging, name, sourceHash)
  await rename(target, previous)
  try {
    await rename(staging, target)
    await rm(previous, { recursive: true, force: true })
  } catch (error) {
    if (!(await isDirectory(target)) && (await isDirectory(previous)))
      await rename(previous, target)
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}
