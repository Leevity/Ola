import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { Language, Parser, type Node } from 'web-tree-sitter'

export type WasmCodeGraphLanguage =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'python'
  | 'go'
  | 'java'
  | 'csharp'
  | 'rust'
  | 'c'
  | 'cpp'
  | 'php'
  | 'ruby'
  | 'scala'
  | 'bash'
  | 'kotlin'
  | 'swift'
  | 'objectivec'
  | 'lua'
  | 'solidity'
  | 'dart'
  | 'haskell'
  | 'julia'
  | 'razor'

/** The production CodeGraph contract is the explicit 18-language WASM matrix. */
export const WASM_CODEGRAPH_LANGUAGES: readonly WasmCodeGraphLanguage[] = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'python',
  'go',
  'java',
  'csharp',
  'rust',
  'c',
  'cpp',
  'php',
  'ruby',
  'scala',
  'bash',
  'haskell',
  'julia',
  'razor'
]

const grammarNames: Partial<Record<WasmCodeGraphLanguage, string>> = {
  typescript: 'typescript',
  tsx: 'tsx',
  javascript: 'javascript',
  jsx: 'javascript',
  python: 'python',
  go: 'go',
  java: 'java',
  csharp: 'c_sharp',
  rust: 'rust',
  c: 'c',
  cpp: 'cpp',
  php: 'php',
  ruby: 'ruby',
  scala: 'scala',
  bash: 'bash',
  kotlin: 'kotlin',
  swift: 'swift',
  objectivec: 'objc',
  lua: 'lua',
  solidity: 'solidity',
  dart: 'dart',
  haskell: 'tree-sitter-haskell.wasm',
  julia: 'tree-sitter-julia.wasm',
  razor: 'tree-sitter-razor.wasm'
}

const bundledGrammarFiles = new Set(['haskell', 'julia', 'razor'])

const require = createRequire(import.meta.url)
const loaded = new Map<WasmCodeGraphLanguage, Promise<Language>>()
let initialized: Promise<void> | undefined

function grammarPath(language: WasmCodeGraphLanguage): string | undefined {
  const grammar = grammarNames[language]
  if (!grammar) return undefined
  if (bundledGrammarFiles.has(language)) {
    const moduleDir = dirname(fileURLToPath(import.meta.url))
    const candidates = [
      join(process.cwd(), 'resources', 'codegraph', 'grammars', grammar),
      join(moduleDir, '../../resources/codegraph/grammars', grammar),
      join(moduleDir, '../../../resources/codegraph/grammars', grammar),
      join(moduleDir, '../../../../resources/codegraph/grammars', grammar)
    ]
    if (process.resourcesPath) {
      candidates.push(
        join(process.resourcesPath, 'app.asar.unpacked/resources/codegraph/grammars', grammar),
        join(process.resourcesPath, 'resources/codegraph/grammars', grammar)
      )
    }
    return candidates.find((candidate) => existsSync(candidate))
  }
  return require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`)
}

/** This matrix is explicit: an unavailable grammar is never silently parsed as another language. */
export function getWasmGrammarStatus(language: WasmCodeGraphLanguage): 'available' | 'unavailable' {
  return grammarPath(language) ? 'available' : 'unavailable'
}

async function initialize(): Promise<void> {
  initialized ??= Parser.init({
    locateFile: () => join(dirname(require.resolve('web-tree-sitter')), 'tree-sitter.wasm')
  })
  return initialized
}

async function loadLanguage(language: WasmCodeGraphLanguage): Promise<Language> {
  const path = grammarPath(language)
  if (!path) throw new Error(`CODEGRAPH_GRAMMAR_UNAVAILABLE:${language}`)
  let result = loaded.get(language)
  if (!result) {
    result = initialize().then(() => Language.load(path))
    loaded.set(language, result)
  }
  return result
}

export interface WasmParseResult {
  rootType: string
  hasError: boolean
  namedNodeCount: number
}

/**
 * Runs a read-only operation while a Tree-sitter tree is alive. Consumers do
 * not receive the parser instance, so they cannot retain a tree after its
 * backing parser has been disposed. Persistent indexing belongs in a later
 * repository layer; this primitive deliberately only owns parsing.
 */
export async function withWasmSyntaxTree<T>(
  language: WasmCodeGraphLanguage,
  source: string,
  operation: (root: Node) => T
): Promise<T> {
  if (new TextEncoder().encode(source).byteLength > 16 * 1024 * 1024)
    throw new Error('CODEGRAPH_SOURCE_TOO_LARGE')
  await initialize()
  const parser = new Parser()
  try {
    parser.setLanguage(await loadLanguage(language))
    const tree = parser.parse(source)
    if (!tree) throw new Error('CODEGRAPH_PARSE_CANCELLED')
    try {
      return operation(tree.rootNode)
    } finally {
      tree.delete()
    }
  } finally {
    parser.delete()
  }
}

/**
 * A worker-safe parse primitive. Symbol extraction remains a separate phase so
 * a grammar failure cannot accidentally corrupt the persistent graph.
 */
export async function parseWithWasm(
  language: WasmCodeGraphLanguage,
  source: string
): Promise<WasmParseResult> {
  return await withWasmSyntaxTree(language, source, (root) => {
    let namedNodeCount = 0
    const stack = [root]
    while (stack.length) {
      const node = stack.pop()!
      if (node.isNamed) namedNodeCount++
      stack.push(...node.namedChildren.filter((child): child is Node => child !== null))
    }
    return { rootType: root.type, hasError: root.hasError, namedNodeCount }
  })
}
