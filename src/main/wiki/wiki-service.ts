import { createHash, randomUUID } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'fs'
import { homedir } from 'os'
import { dirname, extname, join, parse, relative, resolve, sep } from 'path'
import type {
  ProjectWikiDocument,
  ProjectWikiGenerateRequest,
  ProjectWikiNode
} from '../../shared/project-wiki'

const MAX_FILES = 5000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const IGNORED_NAMES = new Set([
  '.git',
  '.ola',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  'tmp',
  '.cache',
  '.ssh',
  '.gnupg',
  'credentials',
  'secrets',
  'private',
  'keys'
])
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.cs',
  '.json',
  '.md',
  '.yaml',
  '.yml',
  '.sql',
  '.css',
  '.html',
  '.xml',
  '.toml'
])

export interface SharedIndexedFile {
  path: string
  language?: string
  nodeCount?: number
  size: number
  indexedAt?: number | null
}

const SENSITIVE_FILE_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /(?:^|[-_.])(secret|secrets|credential|credentials|token|password|private|key)(?:[-_.]|$)/i,
  /\.(?:pem|key|p12|pfx|jks)$/i
]

function isSensitiveFile(name: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name))
}

function validateProjectRoot(projectRoot: string): string {
  const normalized = resolve(projectRoot)
  const realRoot = existsSync(normalized) ? realpathSync(normalized) : normalized
  const home = resolve(homedir())
  const root = parse(realRoot).root
  if (realRoot === root || realRoot === home) {
    throw new Error('Choose a project directory instead of a filesystem or home root.')
  }
  const olaHome = resolve(join(home, '.ola'))
  if (realRoot === olaHome || realRoot.startsWith(`${olaHome}${sep}`)) {
    throw new Error('The Ola data directory cannot be scanned.')
  }
  return realRoot
}

function cachePath(projectRoot: string): string {
  const key = createHash('sha256').update(projectRoot).digest('hex').slice(0, 24)
  const directory = join(homedir(), '.ola', 'wiki')
  mkdirSync(directory, { recursive: true })
  return join(directory, `${key}.json`)
}

function languageForPath(path: string): string | undefined {
  const extension = extname(path).toLowerCase()
  return extension ? extension.slice(1) : undefined
}

function extractSymbols(content: string): string[] {
  const symbols = new Set<string>()
  const patterns = [
    /\b(?:class|interface|type|enum|struct)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:public|private|internal|static|async)\s+(?:class|void|[A-Za-z_$][\w$<>]*)\s+([A-Za-z_$][\w$]*)/g
  ]
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) symbols.add(match[1])
      if (symbols.size >= 80) break
    }
  }
  return Array.from(symbols)
}

function hashFile(path: string): { hash: string; symbols: string[] } {
  const content = readFileSync(path)
  if (content.byteLength > MAX_FILE_BYTES) {
    return { hash: createHash('sha256').update(content).digest('hex'), symbols: [] }
  }
  return {
    hash: createHash('sha256').update(content).digest('hex'),
    symbols: extractSymbols(content.toString('utf8'))
  }
}

function walk(root: string, current: string, nodes: ProjectWikiNode[]): void {
  if (nodes.length >= MAX_FILES) return
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (IGNORED_NAMES.has(entry.name)) continue
    if (entry.isFile() && isSensitiveFile(entry.name)) continue
    const absolutePath = join(current, entry.name)
    const relativePath = relative(root, absolutePath).replaceAll('\\', '/')
    if (entry.isDirectory()) {
      nodes.push({
        path: relativePath,
        kind: 'directory',
        size: 0,
        modifiedAt: statSync(absolutePath).mtimeMs
      })
      walk(root, absolutePath, nodes)
      continue
    }
    if (!entry.isFile()) continue
    const stats = statSync(absolutePath)
    const node: ProjectWikiNode = {
      path: relativePath,
      kind: 'file',
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      language: languageForPath(absolutePath)
    }
    if (TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      try {
        Object.assign(node, hashFile(absolutePath))
      } catch {
        // A file can disappear while scanning; retain metadata only.
      }
    }
    nodes.push(node)
  }
}

function collectProjectMetadata(root: string, current: string, nodes: ProjectWikiNode[]): void {
  if (nodes.length >= MAX_FILES) return
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (IGNORED_NAMES.has(entry.name)) continue
    if (entry.isFile() && isSensitiveFile(entry.name)) continue

    const absolutePath = join(current, entry.name)
    const relativePath = relative(root, absolutePath).replaceAll('\\', '/')
    if (entry.isDirectory()) {
      nodes.push({
        path: relativePath,
        kind: 'directory',
        size: 0,
        modifiedAt: statSync(absolutePath).mtimeMs
      })
      collectProjectMetadata(root, absolutePath, nodes)
      continue
    }
    if (!entry.isFile()) continue

    const stats = statSync(absolutePath)
    nodes.push({
      path: relativePath,
      kind: 'file',
      size: stats.size,
      modifiedAt: stats.mtimeMs
    })
  }
}

function isWikiCacheFresh(
  document: ProjectWikiDocument,
  sharedFiles?: SharedIndexedFile[]
): boolean {
  if (sharedFiles) {
    if (document.fileCount !== sharedFiles.length) return false
    const cachedByPath = new Map(
      document.nodes.filter((node) => node.kind === 'file').map((node) => [node.path, node])
    )
    return sharedFiles.every((file) => {
      const cached = cachedByPath.get(file.path)
      return Boolean(
        cached &&
          cached.kind === 'file' &&
          cached.size === file.size &&
          (!file.indexedAt || Math.abs(cached.modifiedAt - file.indexedAt) <= 1)
      )
    })
  }
  try {
    const root = resolve(document.projectRoot)
    const currentNodes: ProjectWikiNode[] = []
    collectProjectMetadata(root, root, currentNodes)
    if (currentNodes.length !== document.nodes.length) return false

    const cachedByPath = new Map(document.nodes.map((node) => [node.path, node]))
    for (const current of currentNodes) {
      const cached = cachedByPath.get(current.path)
      if (!cached || cached.kind !== current.kind) return false
      if (
        Math.abs(current.modifiedAt - cached.modifiedAt) > 1 ||
        (current.kind === 'file' && current.size !== cached.size)
      ) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

function nodesFromSharedIndex(files: SharedIndexedFile[]): ProjectWikiNode[] {
  const nodes = new Map<string, ProjectWikiNode>()
  for (const file of files) {
    const path = file.path.replaceAll('\\', '/').replace(/^\/+/, '')
    if (!path || isSensitiveFile(parse(path).base)) continue
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join('/')
      if (!nodes.has(directory)) {
        nodes.set(directory, {
          path: directory,
          kind: 'directory',
          size: 0,
          modifiedAt: 0
        })
      }
    }
    nodes.set(path, {
      path,
      kind: 'file',
      size: file.size,
      modifiedAt: file.indexedAt ?? 0,
      language: file.language
    })
  }
  return Array.from(nodes.values()).sort((left, right) => left.path.localeCompare(right.path))
}

export function generateProjectWiki(
  request: ProjectWikiGenerateRequest,
  sharedFiles?: SharedIndexedFile[]
): ProjectWikiDocument {
  const projectRoot = validateProjectRoot(request.projectRoot)
  if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
    throw new Error('Project root must be an existing directory.')
  }
  const target = cachePath(projectRoot)
  if (!request.force && existsSync(target)) {
    try {
      const cached = JSON.parse(readFileSync(target, 'utf8')) as ProjectWikiDocument
      if (cached.projectRoot === projectRoot && isWikiCacheFresh(cached, sharedFiles)) return cached
    } catch {
      // Regenerate an invalid cache.
    }
  }
  const nodes: ProjectWikiNode[] = sharedFiles
    ? nodesFromSharedIndex(sharedFiles)
    : (() => {
        const scanned: ProjectWikiNode[] = []
        walk(projectRoot, projectRoot, scanned)
        scanned.sort((left, right) => left.path.localeCompare(right.path))
        return scanned
      })()
  const document: ProjectWikiDocument = {
    id: randomUUID(),
    projectRoot,
    generatedAt: Date.now(),
    fileCount: nodes.filter((node) => node.kind === 'file').length,
    nodes
  }
  writeFileSync(target, JSON.stringify(document, null, 2), { encoding: 'utf8', mode: 0o600 })
  return document
}

export function loadProjectWiki(projectRoot: string): ProjectWikiDocument | null {
  const path = cachePath(validateProjectRoot(projectRoot))
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ProjectWikiDocument
  } catch {
    return null
  }
}

export function projectWikiMarkdown(document: ProjectWikiDocument): string {
  const lines = [
    '# Project Wiki',
    '',
    `- Root: \`${document.projectRoot}\``,
    `- Files: ${document.fileCount}`,
    `- Generated: ${new Date(document.generatedAt).toISOString()}`,
    ''
  ]
  for (const node of document.nodes) {
    lines.push(`- ${node.kind === 'directory' ? '📁' : '📄'} \`${node.path}\``)
    if (node.symbols?.length) lines.push(`  - Symbols: ${node.symbols.slice(0, 20).join(', ')}`)
  }
  return `${lines.join('\n')}\n`
}

export function writeProjectWikiMarkdown(document: ProjectWikiDocument, destination: string): void {
  const target = resolve(destination)
  const home = resolve(homedir())
  const olaHome = resolve(join(home, '.ola'))
  if (!destination || target === parse(target).root || target.startsWith(`${olaHome}${sep}`)) {
    throw new Error('Wiki export destination is not allowed.')
  }
  if (extname(target).toLowerCase() !== '.md') {
    throw new Error('Wiki export destination must be a Markdown file.')
  }
  if (!existsSync(dirname(target)) || !statSync(dirname(target)).isDirectory()) {
    throw new Error('Wiki export directory does not exist.')
  }
  const realDirectory = realpathSync(dirname(target))
  if (realDirectory === olaHome || realDirectory.startsWith(`${olaHome}${sep}`)) {
    throw new Error('Wiki export destination is not allowed.')
  }
  writeFileSync(target, projectWikiMarkdown(document), { encoding: 'utf8', mode: 0o600 })
}
