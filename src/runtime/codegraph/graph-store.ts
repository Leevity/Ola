import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { dirname, join, normalize } from 'node:path/posix'
import type { WasmCodeGraphLanguage } from './wasm-parser'
import {
  indexWithWasm,
  type WasmCodeGraphImport,
  type WasmCodeGraphReference,
  type WasmCodeGraphSymbol
} from './wasm-indexer'

export interface IndexedCodeGraphSymbol extends WasmCodeGraphSymbol {
  id: string
}
/** A symbol lookup includes the owning file and its parser metadata. */
export interface FoundCodeGraphSymbol extends IndexedCodeGraphSymbol {
  path: string
  language: WasmCodeGraphLanguage
  contentHash: string
  hasParseError: boolean
}
export interface IndexedCodeGraphFile {
  path: string
  contentHash: string
  language: WasmCodeGraphLanguage
  indexedAt: number
  hasParseError: boolean
  symbols: IndexedCodeGraphSymbol[]
  imports: WasmCodeGraphImport[]
  references: WasmCodeGraphReference[]
}

export interface IndexedCodeGraphReference extends WasmCodeGraphReference {
  path: string
  language: WasmCodeGraphLanguage
}

export interface ResolvedCodeGraphImport extends WasmCodeGraphImport {
  targetPath: string | null
}

const RESOLVABLE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.go',
  '.java',
  '.cs',
  '.rs',
  '.c',
  '.cc',
  '.cpp',
  '.php',
  '.rb',
  '.scala'
]

function resolveRelativeImport(
  importingPath: string,
  source: string,
  indexedPaths: ReadonlySet<string>
): string | null {
  if (!source.startsWith('.')) return null
  const base = normalize(join(dirname(importingPath), source))
  if (!base || base === '..' || base.startsWith('../')) return null
  const candidates = [
    base,
    ...RESOLVABLE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...RESOLVABLE_EXTENSIONS.map((extension) => `${base}/index${extension}`)
  ]
  return candidates.find((candidate) => indexedPaths.has(candidate)) ?? null
}

/** Separate TS CodeGraph store. It must not point at the legacy graph database during migration. */
export class WasmCodeGraphStore {
  private readonly worker: Worker
  private sequence = 0
  private closing = false
  private failure: Error | undefined
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()

  constructor(path: string) {
    this.worker = new Worker(new URL('./graph-store-worker.mjs', import.meta.url), {
      workerData: { path }
    })
    this.worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
      const request = this.pending.get(message.id)
      this.pending.delete(message.id)
      message.error ? request?.reject(new Error(message.error)) : request?.resolve(message.result)
    })
    this.worker.on('error', (error) => this.fail(error))
    this.worker.on('exit', () => this.fail(new Error('CODEGRAPH_STORE_CLOSED')))
  }
  private fail(error: Error): void {
    this.failure = error
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }
  private call<T>(method: string, args: unknown = {}): Promise<T> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closing && method !== 'close')
      return Promise.reject(new Error('CODEGRAPH_STORE_CLOSED'))
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
      this.worker.postMessage({ id, method, args })
    })
  }
  async indexFile(input: {
    path: string
    language: WasmCodeGraphLanguage
    source: string
  }): Promise<{ indexedAt: number; symbolCount: number }> {
    const index = await indexWithWasm(input.language, input.source)
    const contentHash = createHash('sha256').update(input.source).digest('hex')
    const symbols: IndexedCodeGraphSymbol[] = index.symbols.map((symbol) => ({
      ...symbol,
      id: createHash('sha256')
        .update(
          `${input.path}\0${symbol.kind}\0${symbol.name}\0${symbol.startLine}\0${symbol.startColumn}`
        )
        .digest('hex')
    }))
    return await this.call('replace-file', {
      path: input.path,
      contentHash,
      language: input.language,
      hasParseError: index.hasParseError,
      symbols,
      imports: index.imports,
      references: index.references
    })
  }
  findSymbols(name: string, limit?: number): Promise<FoundCodeGraphSymbol[]> {
    return this.call('find-symbols', { name, limit })
  }
  searchSymbols(query: string, limit?: number): Promise<FoundCodeGraphSymbol[]> {
    return this.call('search-symbols', { query, limit })
  }
  getFile(path: string): Promise<IndexedCodeGraphFile | null> {
    return this.call('get-file', { path })
  }
  listPaths(): Promise<string[]> {
    return this.call('list-paths')
  }
  removeFile(path: string): Promise<boolean> {
    return this.call('remove-file', { path })
  }
  findReferences(name: string, limit?: number): Promise<IndexedCodeGraphReference[]> {
    return this.call('find-references', { name, limit })
  }
  getImports(path: string): Promise<WasmCodeGraphImport[]> {
    return this.call('get-imports', { path })
  }
  async resolveImports(path: string): Promise<ResolvedCodeGraphImport[]> {
    const [imports, paths] = await Promise.all([this.getImports(path), this.listPaths()])
    const indexedPaths = new Set(paths)
    return imports.map((imported) => ({
      ...imported,
      targetPath: resolveRelativeImport(path, imported.source, indexedPaths)
    }))
  }
  contentHash(source: string): string {
    return createHash('sha256').update(source).digest('hex')
  }
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    try {
      await this.call('close')
    } finally {
      await this.worker.terminate()
    }
  }
}
