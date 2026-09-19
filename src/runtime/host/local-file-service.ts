import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif'
}
const TEXT_READ_BLOCKED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.ico',
  '.tiff',
  '.heic',
  '.heif',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.zip',
  '.gz',
  '.tgz',
  '.rar',
  '.7z',
  '.tar'
])

export type LocalFileReadResult =
  | string
  | { kind: 'image'; mediaType: string; data: string }
  | { error: string }

export type LocalFileMutationResult =
  | { success: true; op?: 'create' | 'modify' }
  | { success: false; error: string }

/** Public document-read shape retained for existing Renderer callers. */
export interface LocalDocumentReadResult {
  content: string | null
  name: string | null
  error: string | null
}

export interface LocalFileStatResult {
  exists: boolean
  type: 'file' | 'directory' | 'other' | null
  size: number | null
  mtimeMs: number | null
  error?: string | null
}

export interface LocalDirectoryEntry {
  name: string
  type: 'file' | 'directory'
  path: string
}

export type LocalDirectoryListResult = LocalDirectoryEntry[] | { error: string }

export interface LocalFileSearchItem {
  path: string
  name: string
}

export interface LocalGlobMatch {
  path: string
  type: 'file' | 'directory'
}

export interface LocalGlobResult {
  matches: LocalGlobMatch[]
  truncated: boolean
}

const DEFAULT_IGNORED_DIRECTORY_NAMES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  'coverage',
  '.nyc_output',
  '.cache',
  '.parcel-cache',
  'vendor',
  'target',
  'bin',
  'obj',
  '.gradle',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.venv',
  'venv',
  'env'
])

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeFileToolPattern(pattern: string): string {
  let normalized = pattern.trim().replace(/\\\\/g, '/').replace(/^\/+/, '')
  if (normalized.startsWith('./')) normalized = normalized.slice(2)
  if (normalized.startsWith('**/')) normalized = normalized.slice(3)
  return normalized
}

function fileToolGlobMatches(pattern: string, relativePath: string, fileName: string): boolean {
  const normalizedPattern = normalizeFileToolPattern(pattern)
  const normalizedRelativePath = normalizeFileToolPattern(relativePath)
  const normalizedFileName = normalizeFileToolPattern(fileName)
  const hasSlash = normalizedPattern.includes('/')
  const hasWildcard = normalizedPattern.includes('*') || normalizedPattern.includes('?')
  const extensionOnly =
    normalizedPattern.startsWith('*.') &&
    !hasSlash &&
    [...normalizedPattern].filter((character) => character === '*').length === 1

  if (extensionOnly)
    return normalizedFileName.toLowerCase().endsWith(normalizedPattern.slice(1).toLowerCase())
  if (!hasWildcard) {
    const lowered = normalizedPattern.toLowerCase()
    return (
      normalizedFileName.toLowerCase() === lowered ||
      normalizedRelativePath.toLowerCase() === lowered ||
      extname(normalizedFileName).toLowerCase() === lowered
    )
  }

  let source = ''
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index]
    if (character === '*') {
      if (normalizedPattern[index + 1] === '*') {
        source += '.*'
        index += 1
      } else {
        source += '[^/]*'
      }
    } else if (character === '?') {
      source += '[^/]'
    } else {
      source += /[+()^$.{}=!|[\]\\]/.test(character) ? `\\${character}` : character
    }
  }
  const matcher = new RegExp(`^${source}$`, 'i')
  return (
    matcher.test(normalizedRelativePath) ||
    (!hasSlash && matcher.test(normalizedFileName)) ||
    (normalizedPattern.endsWith('/') &&
      normalizedRelativePath.toLowerCase().startsWith(normalizedPattern.toLowerCase()))
  )
}

async function readDirectoryIgnorePatterns(
  root: string,
  extraPatterns: readonly string[],
  respectGitignore = true
): Promise<string[]> {
  const patterns = extraPatterns.filter((pattern) => pattern.trim())
  if (!respectGitignore) return patterns
  try {
    const gitignore = await readFile(join(root, '.gitignore'), 'utf8')
    for (const line of gitignore.split(/\r?\n/)) {
      const pattern = line.trim()
      if (pattern && !pattern.startsWith('#') && !pattern.startsWith('!')) patterns.push(pattern)
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code !== 'ENOENT') throw error
  }
  return patterns
}

function normalizeSearchPath(value: string): string {
  return value.replace(/\\\\/g, '/').toLowerCase()
}

function scoreLocalFileSearchMatch(filePath: string, query: string): number {
  const normalizedPath = normalizeSearchPath(filePath)
  const normalizedQuery = normalizeSearchPath(query).trim()
  if (!normalizedQuery) return Number.POSITIVE_INFINITY

  const fileName = basename(normalizedPath)
  if (fileName === normalizedQuery) return 0
  if (fileName.startsWith(normalizedQuery)) return 1
  const fileNameIndex = fileName.indexOf(normalizedQuery)
  if (fileNameIndex >= 0) return 10 + fileNameIndex
  if (normalizedPath === normalizedQuery) return 20
  const pathIndex = normalizedPath.indexOf(normalizedQuery)
  if (pathIndex >= 0) return 30 + pathIndex

  let cursor = 0
  let gapScore = 0
  for (const character of normalizedQuery) {
    const nextIndex = normalizedPath.indexOf(character, cursor)
    if (nextIndex < 0) return Number.POSITIVE_INFINITY
    gapScore += nextIndex - cursor
    cursor = nextIndex + 1
  }
  return 100 + gapScore
}

async function assertSize(filePath: string, limit: number): Promise<void> {
  const metadata = await stat(filePath)
  if (metadata.size > limit) {
    throw new Error(
      `File too large (${(metadata.size / 1024 / 1024).toFixed(1)} MB, limit ${(
        limit /
        1024 /
        1024
      ).toFixed(0)} MB): ${filePath}`
    )
  }
}

function normalizeLineOutput(content: string, offset: number, limit: number): string {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const start = Math.max(0, offset - 1)
  const end = Math.min(start + Math.max(0, Math.min(limit, 2_000)), lines.length)
  const width = Math.max(6, String(end).length)
  return lines
    .slice(start, end)
    .map((line, index) => String(start + index + 1).padStart(width) + '\t' + line)
    .join('\n')
}

export async function readLocalFile(args: {
  path: string
  offset?: number
  limit?: number
  raw?: boolean
  maxFileReadBytes: number
  maxImageReadBytes: number
}): Promise<LocalFileReadResult> {
  try {
    const extension = extname(args.path).toLowerCase()
    if (extension in IMAGE_MIME_TYPES) {
      await assertSize(args.path, args.maxImageReadBytes)
      return {
        kind: 'image',
        mediaType: IMAGE_MIME_TYPES[extension],
        data: (await readFile(args.path)).toString('base64')
      }
    }
    await assertSize(args.path, args.maxFileReadBytes)
    const content = await readFile(args.path, 'utf8')
    return args.raw !== false
      ? content
      : normalizeLineOutput(content, args.offset ?? 1, args.limit ?? 2_000)
  } catch (error) {
    return { error: errorMessage(error) }
  }
}

export async function readLocalDocument(args: {
  path: string
  maxFileReadBytes: number
}): Promise<LocalDocumentReadResult> {
  try {
    if (!args.path.trim()) throw new Error('Missing path')
    await assertSize(args.path, args.maxFileReadBytes)
    const name = basename(args.path)
    if (extname(args.path).toLowerCase() === '.docx') {
      // Mammoth reads only the document package; no renderer or Electron
      // capability is needed, so this remains usable from the Node runtime.
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ path: args.path })
      return { content: result.value.replace(/\r\n?/g, '\n').trim(), name, error: null }
    }
    return { content: await readFile(args.path, 'utf8'), name, error: null }
  } catch (error) {
    return { content: null, name: null, error: errorMessage(error) }
  }
}

export async function readLocalFileBinary(args: {
  path: string
  maxFileReadBytes: number
}): Promise<{ data: string } | { error: string }> {
  try {
    await assertSize(args.path, args.maxFileReadBytes)
    return { data: (await readFile(args.path)).toString('base64') }
  } catch (error) {
    return { error: errorMessage(error) }
  }
}

export async function readLocalTextFileLines(args: {
  path: string
  maxLines: number
  maxFileReadBytes: number
}): Promise<
  | {
      content: string
      name: string
      path: string
      lineCount: number
      maxLines: number
      truncated: boolean
    }
  | { error: string }
> {
  try {
    if (TEXT_READ_BLOCKED_EXTENSIONS.has(extname(args.path).toLowerCase())) {
      return { error: 'This file type cannot be read as plain text' }
    }
    await assertSize(args.path, args.maxFileReadBytes)
    const content = await readFile(args.path, 'utf8')
    const lines = content.split(/\r?\n/)
    const hasTrailingNewline = /\r?\n$/.test(content)
    if (hasTrailingNewline) lines.pop()
    const selected = lines.slice(0, args.maxLines)
    return {
      content: selected.join('\n'),
      name: basename(args.path),
      path: args.path,
      lineCount: selected.length,
      maxLines: args.maxLines,
      truncated: lines.length > args.maxLines
    }
  } catch (error) {
    return { error: errorMessage(error) }
  }
}

export async function statLocalPath(filePath: string): Promise<LocalFileStatResult> {
  try {
    const metadata = await lstat(filePath)
    return {
      exists: true,
      type: metadata.isFile() ? 'file' : metadata.isDirectory() ? 'directory' : 'other',
      size: metadata.isDirectory() ? 0 : metadata.size,
      mtimeMs: metadata.mtimeMs,
      error: null
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT')
      return { exists: false, type: null, size: null, mtimeMs: null, error: null }
    return { exists: false, type: null, size: null, mtimeMs: null, error: errorMessage(error) }
  }
}

export async function writeLocalTextFile(
  filePath: string,
  content: string
): Promise<LocalFileMutationResult> {
  try {
    const before = await statLocalPath(filePath)
    if (before.error) return { success: false, error: before.error }
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content, 'utf8')
    return { success: true, op: before.exists ? 'modify' : 'create' }
  } catch (error) {
    return { success: false, error: errorMessage(error) }
  }
}

export async function writeLocalBinaryFile(
  filePath: string,
  data: string
): Promise<LocalFileMutationResult> {
  try {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, Buffer.from(data, 'base64'))
    return { success: true }
  } catch (error) {
    return { success: false, error: errorMessage(error) }
  }
}

export async function makeLocalDirectory(filePath: string): Promise<LocalFileMutationResult> {
  try {
    await mkdir(filePath, { recursive: true })
    return { success: true }
  } catch (error) {
    return { success: false, error: errorMessage(error) }
  }
}

export async function deleteLocalPath(filePath: string): Promise<LocalFileMutationResult> {
  try {
    const metadata = await statLocalPath(filePath)
    if (!metadata.exists) return { success: true }
    if (metadata.type === 'directory') await rm(filePath, { recursive: true, force: true })
    else await unlink(filePath)
    return { success: true }
  } catch (error) {
    return { success: false, error: errorMessage(error) }
  }
}

export async function moveLocalPath(from: string, to: string): Promise<LocalFileMutationResult> {
  try {
    const metadata = await statLocalPath(from)
    if (!metadata.exists) return { success: false, error: `Path does not exist: ${from}` }
    if (metadata.error) return { success: false, error: metadata.error }
    if (metadata.type === 'file') await rm(to, { force: true })
    await rename(from, to)
    return { success: true }
  } catch (error) {
    return { success: false, error: errorMessage(error) }
  }
}

/**
 * Mirrors the legacy Worker directory-listing contract. It intentionally uses
 * the same limited root `.gitignore` interpretation rather than a complete
 * Git matcher, so desktop tool results do not change during the cutover.
 */
export async function listLocalDirectory(args: {
  path: string
  ignore?: readonly string[]
  limit: number
}): Promise<LocalDirectoryListResult> {
  try {
    const patterns = await readDirectoryIgnorePatterns(args.path, args.ignore ?? [])
    const entries = await readdir(args.path, { withFileTypes: true })
    const result: LocalDirectoryEntry[] = []
    for (const entry of entries) {
      if (result.length >= args.limit) break
      const entryPath = join(args.path, entry.name)
      const directory = entry.isDirectory()
      if (!directory && !entry.isFile()) continue
      if (directory && DEFAULT_IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) continue
      const relativePath = relative(args.path, entryPath).replace(/\\\\/g, '/')
      if (patterns.some((pattern) => fileToolGlobMatches(pattern, relativePath, entry.name)))
        continue
      result.push({ name: entry.name, type: directory ? 'directory' : 'file', path: entryPath })
    }
    return result
  } catch (error) {
    return { error: errorMessage(error) }
  }
}

/** Searches files using the same ranking and limited ignore rules as the legacy Worker. */
export async function searchLocalFiles(args: {
  path: string
  query: string
  limit: number
}): Promise<LocalFileSearchItem[]> {
  const patterns = await readDirectoryIgnorePatterns(args.path, [])
  const candidates: string[] = []
  const directories = [args.path]

  while (directories.length > 0) {
    const directory = directories.pop()
    if (!directory) continue
    let entries: Dirent<string>[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const entryPath = join(directory, entry.name)
      const directoryEntry = entry.isDirectory()
      if (entry.isSymbolicLink()) continue
      const relativePath = relative(args.path, entryPath).replace(/\\\\/g, '/')
      if (directoryEntry && DEFAULT_IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) continue
      if (patterns.some((pattern) => fileToolGlobMatches(pattern, relativePath, entry.name)))
        continue
      if (directoryEntry) directories.push(entryPath)
      else if (entry.isFile()) candidates.push(relativePath)
    }
  }

  const query = args.query.trim()
  const ranked = query
    ? candidates
        .map((filePath) => ({ path: filePath, score: scoreLocalFileSearchMatch(filePath, query) }))
        .filter((item) => Number.isFinite(item.score))
        .sort((left, right) => left.score - right.score || left.path.localeCompare(right.path))
    : candidates
        .sort((left, right) => left.localeCompare(right))
        .map((filePath) => ({ path: filePath, score: 0 }))
  return ranked.slice(0, args.limit).map(({ path: filePath }) => ({
    path: filePath,
    name: basename(filePath)
  }))
}

function compareCaseInsensitivePath(left: string, right: string): number {
  const normalizedLeft = left.toLowerCase()
  const normalizedRight = right.toLowerCase()
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0
}

function hasHiddenPathSegment(relativePath: string): boolean {
  return relativePath.split('/').some((part) => part.startsWith('.') && part !== '.')
}

/** Enumerates glob matches with the legacy Worker depth, ordering, and cap semantics. */
export async function globLocalFiles(args: {
  path: string
  pattern: string
  limit: number
  hidden: boolean
  respectGitignore: boolean
  maxDepth: number | null
}): Promise<LocalGlobResult> {
  const patterns = await readDirectoryIgnorePatterns(args.path, [], args.respectGitignore)
  const matches: Array<LocalGlobMatch & { mtimeMs: number }> = []
  const directories = [args.path]
  let truncated = false

  while (directories.length > 0 && !truncated) {
    const directory = directories.pop()
    if (!directory) continue
    let entries: Dirent<string>[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const entryPath = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      const directoryEntry = entry.isDirectory()
      if (!directoryEntry && !entry.isFile()) continue
      const relativePath = relative(args.path, entryPath).replace(/\\\\/g, '/')
      const depth = Math.max(0, relativePath.split('/').filter(Boolean).length - 1)
      if (args.maxDepth !== null && depth > args.maxDepth) continue
      if (!args.hidden && hasHiddenPathSegment(relativePath)) continue
      if (directoryEntry && DEFAULT_IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) continue
      if (patterns.some((pattern) => fileToolGlobMatches(pattern, relativePath, entry.name)))
        continue

      if (directoryEntry) directories.push(entryPath)
      if (!fileToolGlobMatches(args.pattern, relativePath, entry.name)) continue
      let mtimeMs = 0
      try {
        mtimeMs = (await stat(entryPath)).mtimeMs
      } catch {
        // The legacy Worker treats an unreadable modification time as zero.
      }
      matches.push({ path: entryPath, type: directoryEntry ? 'directory' : 'file', mtimeMs })
      if (matches.length >= 1_000) {
        truncated = true
        break
      }
    }
  }

  return {
    matches: matches
      .sort(
        (left, right) =>
          right.mtimeMs - left.mtimeMs || compareCaseInsensitivePath(left.path, right.path)
      )
      .slice(0, args.limit)
      .map(({ path, type }) => ({ path, type })),
    truncated
  }
}
