import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { olaDataRoot } from '../lib/ola-data-root'
import { WasmCodeGraphStore } from '../../runtime/codegraph/graph-store'
import { indexWorkspaceWithWasm } from '../../runtime/codegraph/workspace-indexer'

type CodeGraphErrorKind = 'not_indexed' | 'path_refusal' | 'invalid_args' | 'internal'

type ProjectMetadata = {
  root: string
  lastIndexedAt: number
}

type Project = {
  root: string
  hash: string
  store: WasmCodeGraphStore
  metadataPath: string
  lastIndexedAt: number
  indexing: boolean
}

export type TsCodeGraphProgress = {
  indexId: string
  phase: 'scan' | 'index' | 'complete'
  filesDone: number
  filesTotal: number
  nodeCount: number
  edgeCount: number
  message?: string
}

const MAX_QUERY_LIMIT = 500

const CODEGRAPH_TOOLS = [
  'codegraph_explore',
  'codegraph_search',
  'codegraph_node',
  'codegraph_callers',
  'codegraph_callees',
  'codegraph_impact',
  'codegraph_files',
  'codegraph_status'
] as const

const CODEGRAPH_INDEXED_INSTRUCTIONS =
  '# CodeGraph\n\nThis project has a TS/WASM CodeGraph index. Prefer `codegraph_explore` for understanding relationships between symbols.\n'
const CODEGRAPH_NO_ROOT_INSTRUCTIONS =
  '# CodeGraph\n\nThis project is not indexed yet. Run `codegraph/index` first, then prefer `codegraph_explore` for symbol relationships.\n'

function error(
  kind: CodeGraphErrorKind,
  message: string
): { success: false; error: string; errorKind: CodeGraphErrorKind } {
  return { success: false, error: message, errorKind: kind }
}

function notIndexed<T extends object>(value: T): T & { success: true; errorKind: 'not_indexed' } {
  return { ...value, success: true, errorKind: 'not_indexed' }
}

function projectHash(root: string): string {
  return createHash('sha256').update(root).digest('hex')
}

function isSafeProjectRoot(root: string): boolean {
  const normalized = resolve(root)
  const home = resolve(homedir())
  return normalized !== sep && normalized !== home && !home.startsWith(`${normalized}${sep}`)
}

function asRoot(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null
  const value = (params as Record<string, unknown>).workingFolder
  if (typeof value !== 'string' || !value.trim()) return null
  return resolve(value)
}

function asString(params: unknown, key: string): string | null {
  if (!params || typeof params !== 'object') return null
  const value = (params as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asLimit(params: unknown, fallback: number): number {
  if (!params || typeof params !== 'object') return fallback
  const value = (params as Record<string, unknown>).limit
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_QUERY_LIMIT, Math.floor(value)))
    : fallback
}

/**
 * Main-owned TS/WASM CodeGraph adapter. It uses an isolated data root so index
 * replacement and recovery cannot corrupt or race the current production index.
 */
export class TsCodeGraphService {
  private readonly projects = new Map<string, Project>()

  constructor(
    private readonly dataRoot = join(olaDataRoot(), 'codegraph-ts'),
    private readonly onProgress: (progress: TsCodeGraphProgress) => void = () => undefined
  ) {}

  async request(method: string, params: unknown = {}): Promise<unknown> {
    const root = asRoot(params)
    if (method === 'worker/ping') return { ok: true, runtime: 'ts-wasm' }
    if (method === 'codegraph/db-smoke') {
      return { success: true, runtime: 'ts-wasm', backend: 'node:sqlite' }
    }
    if (method === 'codegraph/list-projects') return await this.listProjects()
    if (method === 'codegraph/remove-project') return await this.removeProject(params)
    if (method === 'codegraph/instructions') {
      const indexed = Boolean(root && (await this.indexed(root)))
      return {
        success: true,
        text: indexed ? CODEGRAPH_INDEXED_INSTRUCTIONS : CODEGRAPH_NO_ROOT_INSTRUCTIONS,
        indexed
      }
    }
    if (method === 'codegraph/tools-list') {
      return {
        success: true,
        tools: CODEGRAPH_TOOLS.map((name) => ({ name, readOnly: true }))
      }
    }
    if (!root) return error('invalid_args', 'workingFolder is required.')
    if (!isSafeProjectRoot(root))
      return error('path_refusal', `Refused to operate on a sensitive path: ${root}`)
    if (!existsSync(root)) return error('invalid_args', `Project path does not exist: ${root}`)

    switch (method) {
      case 'codegraph/index':
      case 'codegraph/sync':
        return await this.index(root, method === 'codegraph/sync')
      case 'codegraph/index-status':
        return await this.indexStatus(root)
      case 'codegraph/stats':
        return await this.stats(root)
      case 'codegraph/files-tree':
        return await this.filesTree(root, params)
      case 'codegraph/file-symbols':
        return await this.fileSymbols(root, params)
      case 'codegraph/node':
        return await this.node(root, params)
      case 'codegraph/search':
      case 'codegraph/explore':
      case 'codegraph/callers':
      case 'codegraph/callees':
      case 'codegraph/impact':
        return await this.search(root, method, params)
      case 'codegraph/query-neighbors':
        return await this.neighbors(root, params)
      case 'codegraph/analytics':
        return await this.analytics(root)
      case 'codegraph/prompt-context':
        return await this.promptContext(root, params)
      case 'codegraph/status':
        return await this.statusTool(root)
      case 'codegraph/files':
        return await this.filesTool(root)
      default:
        return error('invalid_args', `Unsupported TS CodeGraph method: ${method}`)
    }
  }

  async close(): Promise<void> {
    const projects = [...this.projects.values()]
    this.projects.clear()
    await Promise.all(projects.map((project) => project.store.close()))
  }

  private async open(root: string, requireIndexed = true): Promise<Project | null> {
    const hash = projectHash(root)
    const active = this.projects.get(hash)
    if (active) return active
    const directory = join(this.dataRoot, hash)
    const metadataPath = join(directory, 'workspace.json')
    if (requireIndexed && !existsSync(metadataPath)) return null
    await mkdir(directory, { recursive: true })
    let metadata: ProjectMetadata | null = null
    try {
      metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as ProjectMetadata
    } catch {
      // A missing or corrupt metadata file is treated as an unindexed project. The
      // graph database is not reused until a successful explicit index replaces it.
    }
    if (requireIndexed && metadata?.root !== root) return null
    const project: Project = {
      root,
      hash,
      store: new WasmCodeGraphStore(join(directory, 'graph.db')),
      metadataPath,
      lastIndexedAt: metadata?.lastIndexedAt ?? 0,
      indexing: false
    }
    this.projects.set(hash, project)
    return project
  }

  private async index(root: string, sync: boolean): Promise<unknown> {
    const project = await this.open(root, false)
    if (!project) return error('internal', 'Unable to open the TS CodeGraph store.')
    if (project.indexing)
      return { success: false, error: 'This project is already indexing.', errorKind: 'internal' }
    project.indexing = true
    const indexId = `ts-${Date.now().toString(36)}-${project.hash.slice(0, 8)}`
    const before = await project.store.listPaths()
    this.onProgress({
      indexId,
      phase: 'scan',
      filesDone: 0,
      filesTotal: 0,
      nodeCount: 0,
      edgeCount: 0
    })
    try {
      const result = await indexWorkspaceWithWasm({ root, store: project.store })
      const files = await project.store.listPaths()
      let nodeCount = 0
      let edgeCount = 0
      for (const path of files) {
        const file = await project.store.getFile(path)
        nodeCount += file?.symbols.length ?? 0
        edgeCount += file?.imports.length ?? 0
      }
      project.lastIndexedAt = Date.now()
      await writeFile(
        project.metadataPath,
        `${JSON.stringify({ root, lastIndexedAt: project.lastIndexedAt } satisfies ProjectMetadata)}\n`,
        { mode: 0o600 }
      )
      this.onProgress({
        indexId,
        phase: 'complete',
        filesDone: files.length,
        filesTotal: files.length,
        nodeCount,
        edgeCount,
        message: result.errors.length
          ? `${result.errors.length} file(s) failed to index.`
          : undefined
      })
      if (sync) {
        return {
          success: true,
          filesChanged: result.indexed,
          filesAdded: Math.max(0, files.length - before.length),
          filesRemoved: result.removed,
          nodesUpdated: nodeCount,
          edgesUpdated: edgeCount,
          durationMs: 0
        }
      }
      return {
        success: true,
        indexId,
        state: result.errors.length ? 'partial' : 'complete',
        filesIndexed: result.indexed,
        nodeCount,
        edgeCount,
        unresolvedCount: 0,
        durationMs: 0,
        indexedWithVersion: 'ts-wasm-v1',
        errors: result.errors,
        unsupportedFiles: result.unsupported
      }
    } catch (cause) {
      return error('internal', cause instanceof Error ? cause.message : String(cause))
    } finally {
      project.indexing = false
    }
  }

  private async indexed(root: string): Promise<Project | null> {
    return await this.open(root, true)
  }

  private async snapshot(project: Project): Promise<{
    files: Awaited<ReturnType<WasmCodeGraphStore['getFile']>>[]
    nodeCount: number
    edgeCount: number
  }> {
    const files = await Promise.all(
      (await project.store.listPaths()).map((path) => project.store.getFile(path))
    )
    return {
      files,
      nodeCount: files.reduce((count, file) => count + (file?.symbols.length ?? 0), 0),
      edgeCount: files.reduce((count, file) => count + (file?.imports.length ?? 0), 0)
    }
  }

  private async indexStatus(root: string): Promise<unknown> {
    const project = await this.indexed(root)
    if (!project) {
      return notIndexed({
        indexed: false,
        indexing: false,
        state: null,
        fileCount: 0,
        nodeCount: 0,
        edgeCount: 0,
        stale: false
      })
    }
    const snapshot = await this.snapshot(project)
    return {
      success: true,
      indexed: true,
      indexing: project.indexing,
      state: project.indexing ? 'indexing' : 'complete',
      lastIndexedAt: project.lastIndexedAt || null,
      fileCount: snapshot.files.length,
      nodeCount: snapshot.nodeCount,
      edgeCount: snapshot.edgeCount,
      pendingReferenceCount: 0,
      dbSizeBytes: 0,
      backend: 'node:sqlite',
      journalMode: 'wal',
      stale: false,
      indexedWithVersion: 'ts-wasm-v1'
    }
  }

  private async stats(root: string): Promise<unknown> {
    const project = await this.indexed(root)
    if (!project)
      return notIndexed({ nodeCount: 0, edgeCount: 0, fileCount: 0, filesByLanguage: [] })
    const snapshot = await this.snapshot(project)
    const languages = new Map<string, number>()
    const kinds = new Map<string, number>()
    for (const file of snapshot.files) {
      if (!file) continue
      languages.set(file.language, (languages.get(file.language) ?? 0) + 1)
      for (const symbol of file.symbols) kinds.set(symbol.kind, (kinds.get(symbol.kind) ?? 0) + 1)
    }
    const buckets = (input: Map<string, number>) =>
      [...input]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    return {
      success: true,
      nodeCount: snapshot.nodeCount,
      edgeCount: snapshot.edgeCount,
      fileCount: snapshot.files.length,
      nodesByKind: buckets(kinds),
      edgesByKind: [{ key: 'import', count: snapshot.edgeCount }],
      filesByLanguage: buckets(languages),
      dbSizeBytes: 0,
      lastUpdated: project.lastIndexedAt
    }
  }

  private async filesTree(root: string, params: unknown): Promise<unknown> {
    const project = await this.indexed(root)
    if (!project) return notIndexed({ files: [] })
    const filter = asString(params, 'path')?.replaceAll('\\', '/')
    const files = await Promise.all(
      (await project.store.listPaths()).map(async (path) => {
        const file = await project.store.getFile(path)
        const disk = await stat(join(root, path)).catch(() => null)
        return file
          ? { path, language: file.language, nodeCount: file.symbols.length, size: disk?.size ?? 0 }
          : null
      })
    )
    return {
      success: true,
      files: files.filter(
        (file): file is NonNullable<typeof file> =>
          Boolean(file) && (!filter || file!.path.startsWith(filter))
      )
    }
  }

  private async fileSymbols(root: string, params: unknown): Promise<unknown> {
    const project = await this.indexed(root)
    if (!project) return notIndexed({ symbols: [] })
    const path = asString(params, 'path')
    if (!path) return error('invalid_args', 'path is required.')
    const file = await project.store.getFile(path)
    return { success: true, symbols: file?.symbols ?? [] }
  }

  private async node(root: string, params: unknown): Promise<unknown> {
    const file = asString(params, 'file')
    if (file) return await this.fileSymbols(root, { path: file })
    const symbol = asString(params, 'symbol') ?? asString(params, 'query')
    if (!symbol) return error('invalid_args', 'symbol or file is required.')
    return await this.search(root, 'codegraph/search', {
      ...((params ?? {}) as object),
      query: symbol
    })
  }

  private async promptContext(root: string, params: unknown): Promise<unknown> {
    const query = asString(params, 'query') ?? asString(params, 'symbol')
    if (!query) return error('invalid_args', 'query or symbol is required.')
    const result = await this.search(root, 'codegraph/explore', { query })
    return {
      success: true,
      text: `TS CodeGraph context for ${query}:\n${(result as { text?: string }).text ?? ''}`
    }
  }

  private async relationSearch(
    project: Project,
    method: 'codegraph/callers' | 'codegraph/callees' | 'codegraph/impact',
    params: unknown
  ): Promise<{ success: true; text: string; isError: false } | ReturnType<typeof error>> {
    const symbolName = asString(params, 'symbol') ?? asString(params, 'query')
    if (!symbolName) return error('invalid_args', 'query or symbol is required.')
    const fileFilter = asString(params, 'file')
    const depthValue =
      params && typeof params === 'object' ? (params as Record<string, unknown>).depth : undefined
    const depth =
      typeof depthValue === 'number' && Number.isFinite(depthValue)
        ? Math.max(1, Math.min(6, Math.floor(depthValue)))
        : 2
    const limit = asLimit(params, 50)
    const files = (
      await Promise.all(
        (await project.store.listPaths()).map((path) => project.store.getFile(path))
      )
    ).filter((file): file is NonNullable<typeof file> => Boolean(file))
    const definitions = files.flatMap((file) =>
      file.symbols.map((symbol) => ({ ...symbol, path: file.path, language: file.language }))
    )
    const matches = definitions.filter(
      (definition) =>
        definition.name === symbolName && (!fileFilter || definition.path === fileFilter)
    )
    if (!matches.length) {
      return { success: true, text: `No symbol named "${symbolName}" found.`, isError: false }
    }

    const enclosing = (path: string, line: number, column: number) => {
      const candidates = definitions.filter(
        (definition) =>
          definition.path === path &&
          (line > definition.startLine ||
            (line === definition.startLine && column >= definition.startColumn)) &&
          (line < definition.endLine ||
            (line === definition.endLine && column <= definition.endColumn))
      )
      return candidates.sort(
        (left, right) =>
          left.endLine - left.startLine - (right.endLine - right.startLine) ||
          left.endColumn - left.startColumn - (right.endColumn - right.startColumn)
      )[0]
    }

    const callsFrom = new Map<string, Set<string>>()
    const callsTo = new Map<string, Set<string>>()
    const byName = new Map<string, typeof definitions>()
    for (const definition of definitions) {
      const list = byName.get(definition.name) ?? []
      list.push(definition)
      byName.set(definition.name, list)
    }
    for (const file of files) {
      for (const reference of file.references) {
        const owner = enclosing(file.path, reference.startLine, reference.startColumn)
        if (!owner) continue
        for (const target of byName.get(reference.name) ?? []) {
          if (target.id === owner.id) continue
          const outgoing = callsFrom.get(owner.id) ?? new Set<string>()
          outgoing.add(target.id)
          callsFrom.set(owner.id, outgoing)
          const incoming = callsTo.get(target.id) ?? new Set<string>()
          incoming.add(owner.id)
          callsTo.set(target.id, incoming)
        }
      }
    }

    const format = (definition: (typeof definitions)[number]) =>
      `${definition.name} (${definition.kind}) — ${definition.path}:${definition.startLine}`
    const direct = (root: (typeof definitions)[number], reverse: boolean) => {
      const ids = reverse ? callsTo.get(root.id) : callsFrom.get(root.id)
      return definitions.filter((candidate) => ids?.has(candidate.id))
    }
    const results: Array<(typeof definitions)[number]> = []
    const seen = new Set<string>()
    for (const root of matches) {
      const queue: Array<{ id: string; level: number }> = [{ id: root.id, level: 0 }]
      const reverse = method === 'codegraph/callers'
      while (queue.length && results.length < limit) {
        const current = queue.shift()!
        if (current.level >= depth) continue
        const currentDefinition = definitions.find((candidate) => candidate.id === current.id)
        if (!currentDefinition) continue
        for (const next of direct(currentDefinition, reverse)) {
          if (seen.has(next.id)) continue
          seen.add(next.id)
          results.push(next)
          queue.push({ id: next.id, level: current.level + 1 })
          if (results.length >= limit) break
        }
      }
    }
    if (method === 'codegraph/impact') {
      const affected = new Map<string, (typeof definitions)[number]>()
      for (const root of matches) {
        const queue: Array<{ id: string; level: number }> = [{ id: root.id, level: 0 }]
        const visited = new Set<string>([root.id])
        while (queue.length && affected.size < limit) {
          const current = queue.shift()!
          if (current.level >= depth) continue
          const currentDefinition = definitions.find((candidate) => candidate.id === current.id)
          if (!currentDefinition) continue
          for (const next of [
            ...direct(currentDefinition, false),
            ...direct(currentDefinition, true)
          ]) {
            if (visited.has(next.id)) continue
            visited.add(next.id)
            affected.set(next.id, next)
            queue.push({ id: next.id, level: current.level + 1 })
          }
        }
      }
      results.splice(0, results.length, ...affected.values())
    }
    const heading =
      method === 'codegraph/callers'
        ? 'Callers'
        : method === 'codegraph/callees'
          ? 'Callees'
          : 'Impact'
    const text = results.length
      ? `${heading} of ${symbolName} (${results.length} result(s), depth ${depth}):\n${results
          .map((result) => `- ${format(result)}`)
          .join('\n')}`
      : `No ${heading.toLowerCase()} found for "${symbolName}".`
    return { success: true, text, isError: false }
  }

  private async search(root: string, method: string, params: unknown): Promise<unknown> {
    const project = await this.indexed(root)
    if (!project)
      return {
        success: true,
        text: 'Project is not indexed; run codegraph/index first.',
        isError: false,
        errorKind: 'not_indexed'
      }
    const query =
      asString(params, method === 'codegraph/explore' ? 'query' : 'symbol') ??
      asString(params, 'query')
    if (!query) return error('invalid_args', 'query or symbol is required.')
    if (
      method === 'codegraph/callers' ||
      method === 'codegraph/callees' ||
      method === 'codegraph/impact'
    )
      return await this.relationSearch(project, method, params)
    const symbols = await (method === 'codegraph/search' || method === 'codegraph/explore'
      ? project.store.searchSymbols(query, asLimit(params, 30))
      : project.store.findSymbols(query, asLimit(params, 30)))
    const references = await project.store.findReferences(query, asLimit(params, 30))
    const lines = [
      ...symbols.map(
        (symbol) => `${symbol.kind} ${symbol.name} — ${symbol.path}:${symbol.startLine + 1}`
      ),
      ...references.map(
        (reference) => `reference ${reference.name} — ${reference.path}:${reference.startLine + 1}`
      )
    ]
    const text = lines.length
      ? lines.join('\n')
      : `No indexed symbols or references match “${query}”.`
    return { success: true, text, isError: false }
  }

  private async neighbors(root: string, params: unknown): Promise<unknown> {
    const project = await this.indexed(root)
    if (!project) return notIndexed({ nodes: [], edges: [], roots: [], confidence: null })
    const symbol = asString(params, 'symbol')
    if (!symbol) return { success: true, nodes: [], edges: [], roots: [], confidence: null }
    const symbols = await project.store.findSymbols(symbol, asLimit(params, 100))
    const nodes = symbols.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      filePath: item.path,
      startLine: item.startLine
    }))
    const edges: Array<{ source: string; target: string; kind: string }> = []
    for (const item of symbols) {
      for (const imported of await project.store.resolveImports(item.path)) {
        if (imported.targetPath)
          edges.push({ source: item.id, target: imported.targetPath, kind: 'import' })
      }
    }
    return { success: true, nodes, edges, roots: nodes.map((node) => node.id), confidence: null }
  }

  private async analytics(root: string): Promise<unknown> {
    const project = await this.indexed(root)
    if (!project)
      return notIndexed({
        circularDependencies: [],
        circularTotal: 0,
        deadCode: [],
        deadCodeTotal: 0
      })
    const snapshot = await this.snapshot(project)
    const files = snapshot.files.filter((file): file is NonNullable<typeof file> => Boolean(file))
    const indexedPaths = new Set(files.map((file) => file.path))
    const dependencies = new Map<string, string[]>()
    for (const file of files) {
      const targets = new Set<string>()
      const resolved = await project.store.resolveImports(file.path)
      for (const imported of file.imports) {
        const target = resolved.find(
          (candidate) =>
            candidate.source === imported.source &&
            candidate.targetPath &&
            indexedPaths.has(candidate.targetPath)
        )?.targetPath
        if (target) targets.add(target)
      }
      dependencies.set(file.path, [...targets].sort())
    }

    const cycles: string[][] = []
    const cycleKeys = new Set<string>()
    const visit = (path: string, stack: string[], active: Set<string>): void => {
      if (cycles.length >= 50) return
      const position = stack.indexOf(path)
      if (position >= 0) {
        const cycle = stack.slice(position)
        if (cycle.length > 1) {
          const rotations = cycle.map((_, index) => [
            ...cycle.slice(index),
            ...cycle.slice(0, index)
          ])
          const canonicalRotation = rotations.sort((left, right) => {
            const leftKey = left.join('\0')
            const rightKey = right.join('\0')
            return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
          })[0]
          const canonical = canonicalRotation?.join('\0')
          if (canonical && canonicalRotation && !cycleKeys.has(canonical)) {
            cycleKeys.add(canonical)
            cycles.push(canonicalRotation)
          }
        }
        return
      }
      if (active.has(path)) return
      active.add(path)
      const nextStack = [...stack, path]
      for (const target of dependencies.get(path) ?? []) visit(target, nextStack, active)
      active.delete(path)
    }
    for (const path of indexedPaths) visit(path, [], new Set())

    const referencedNames = new Set(
      files.flatMap((file) => file.references.map((reference) => reference.name))
    )
    const allDeadCode = files
      .flatMap((file) =>
        file.symbols
          .filter((symbol) => !symbol.exported && !referencedNames.has(symbol.name))
          .map((symbol) => ({
            id: symbol.id,
            name: symbol.name,
            kind: symbol.kind,
            filePath: file.path,
            startLine: symbol.startLine
          }))
      )
      .sort(
        (left, right) =>
          left.filePath.localeCompare(right.filePath) || left.startLine - right.startLine
      )
    const deadCode = allDeadCode.slice(0, 200)
    return {
      success: true,
      circularDependencies: cycles.slice(0, 50).map((files) => ({ files })),
      circularTotal: cycles.length,
      deadCode,
      deadCodeTotal: allDeadCode.length
    }
  }

  private async statusTool(root: string): Promise<unknown> {
    const status = await this.indexStatus(root)
    const snapshot = status as {
      indexed?: boolean
      fileCount?: number
      nodeCount?: number
      edgeCount?: number
    }
    return {
      success: true,
      text: snapshot.indexed
        ? `TS/WASM CodeGraph: ${snapshot.fileCount} files, ${snapshot.nodeCount} symbols, ${snapshot.edgeCount} import edges.`
        : 'Project is not indexed; run codegraph/index first.',
      isError: false,
      ...(snapshot.indexed ? {} : { errorKind: 'not_indexed' })
    }
  }

  private async filesTool(root: string): Promise<unknown> {
    const result = (await this.filesTree(root, {})) as { files?: Array<{ path: string }> }
    return {
      success: true,
      text: result.files?.map((file) => file.path).join('\n') || 'No indexed files.',
      isError: false
    }
  }

  private async listProjects(): Promise<unknown> {
    if (!existsSync(this.dataRoot)) return { success: true, projects: [] }
    const directories = await (
      await import('node:fs/promises')
    ).readdir(this.dataRoot, { withFileTypes: true })
    const projects = await Promise.all(
      directories
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            const metadata = JSON.parse(
              await readFile(join(this.dataRoot, entry.name, 'workspace.json'), 'utf8')
            ) as ProjectMetadata
            const project = await this.open(metadata.root, true)
            const snapshot = project
              ? await this.snapshot(project)
              : { files: [], nodeCount: 0, edgeCount: 0 }
            return {
              root: metadata.root,
              hash: entry.name,
              state: 'complete',
              files: snapshot.files.length,
              nodes: snapshot.nodeCount,
              edges: snapshot.edgeCount,
              dbSizeBytes: 0,
              lastIndexedAt: metadata.lastIndexedAt
            }
          } catch {
            return null
          }
        })
    )
    return { success: true, projects: projects.filter(Boolean) }
  }

  private async removeProject(params: unknown): Promise<unknown> {
    const root = asRoot(params)
    if (!root) return error('invalid_args', 'workingFolder is required.')
    const project = this.projects.get(projectHash(root))
    if (project) {
      this.projects.delete(project.hash)
      await project.store.close()
    }
    const { rm } = await import('node:fs/promises')
    await rm(join(this.dataRoot, projectHash(root)), { recursive: true, force: true })
    return { success: true }
  }
}
