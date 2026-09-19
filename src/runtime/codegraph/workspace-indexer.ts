import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { getWasmGrammarStatus, type WasmCodeGraphLanguage } from './wasm-parser'
import { WasmCodeGraphStore } from './graph-store'

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, WasmCodeGraphLanguage>> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.go': 'go',
  '.java': 'java',
  '.cs': 'csharp',
  '.rs': 'rust',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.php': 'php',
  '.rb': 'ruby',
  '.scala': 'scala',
  '.sh': 'bash',
  '.bash': 'bash',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.m': 'objectivec',
  '.mm': 'objectivec',
  '.lua': 'lua',
  '.sol': 'solidity',
  '.dart': 'dart',
  '.hs': 'haskell',
  '.lhs': 'haskell',
  '.jl': 'julia',
  '.razor': 'razor'
}
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'out',
  'build'
])

export function languageForCodeGraphPath(path: string): WasmCodeGraphLanguage | null {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  const language = LANGUAGE_BY_EXTENSION[extension]
  return language && getWasmGrammarStatus(language) === 'available' ? language : null
}

function declaredLanguageForCodeGraphPath(path: string): WasmCodeGraphLanguage | null {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  return LANGUAGE_BY_EXTENSION[extension] ?? null
}

export async function indexWorkspaceWithWasm(input: {
  root: string
  store: WasmCodeGraphStore
  signal?: AbortSignal
  maxFiles?: number
}): Promise<{
  indexed: number
  skipped: number
  removed: number
  errors: Array<{ path: string; error: string }>
  unsupported: Array<{ path: string; language: WasmCodeGraphLanguage; error: string }>
}> {
  const root = resolve(input.root)
  const maxFiles = Math.min(100000, Math.max(1, input.maxFiles ?? 10000))
  const errors: Array<{ path: string; error: string }> = []
  const unsupported: Array<{
    path: string
    language: WasmCodeGraphLanguage
    error: string
  }> = []
  let indexed = 0
  let skipped = 0
  let scanComplete = true
  const seenPaths = new Set<string>()
  const visit = async (directory: string): Promise<void> => {
    input.signal?.throwIfAborted()
    let entries: Dirent<string>[]
    try {
      entries = await readdir(directory, { withFileTypes: true, encoding: 'utf8' })
    } catch (error) {
      scanComplete = false
      errors.push({
        path: relative(root, directory),
        error: error instanceof Error ? error.message : 'READ_DIRECTORY_FAILED'
      })
      return
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      input.signal?.throwIfAborted()
      const path = resolve(directory, entry.name)
      if (entry.isSymbolicLink()) {
        skipped++
        continue
      }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) {
          skipped++
          continue
        }
        await visit(path)
        continue
      }
      const declaredLanguage = entry.isFile() ? declaredLanguageForCodeGraphPath(path) : null
      const language = declaredLanguage ? languageForCodeGraphPath(path) : null
      if (!language) {
        if (declaredLanguage) {
          unsupported.push({
            path: relative(root, path),
            language: declaredLanguage,
            error: `CODEGRAPH_GRAMMAR_UNAVAILABLE:${declaredLanguage}`
          })
        }
        skipped++
        continue
      }
      const relativePath = relative(root, path)
      if (!relativePath || relativePath.startsWith(`..${sep}`)) {
        skipped++
        continue
      }
      if (indexed >= maxFiles) {
        scanComplete = false
        skipped++
        continue
      }
      seenPaths.add(relativePath)
      try {
        const source = await readFile(path, 'utf8')
        const previous = await input.store.getFile(relativePath)
        if (previous?.contentHash === input.store.contentHash(source)) {
          skipped++
          continue
        }
        await input.store.indexFile({ path: relativePath, language, source })
        indexed++
      } catch (error) {
        scanComplete = false
        errors.push({
          path: relativePath,
          error: error instanceof Error ? error.message : 'INDEX_FILE_FAILED'
        })
      }
    }
  }
  await visit(root)
  let removed = 0
  if (scanComplete) {
    for (const path of await input.store.listPaths()) {
      if (!seenPaths.has(path) && (await input.store.removeFile(path))) removed++
    }
  }
  return { indexed, skipped, removed, errors, unsupported }
}
