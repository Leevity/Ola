/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const grammarManifestPath = fileURLToPath(
  new URL('../src/shared/codegraph-grammars.json', import.meta.url)
)

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function validateLibraryName(value, label) {
  const library = requireString(value, label)
  if (!/^tree-sitter(?:-[a-z0-9]+)*$/.test(library)) {
    throw new Error(`${label} is not a portable tree-sitter library name: ${library}`)
  }
  return library
}

export function validateGrammarManifest(value) {
  const manifest = requireObject(value, 'manifest')
  if (manifest.schemaVersion !== 1) throw new Error('manifest.schemaVersion must be 1')
  const source = requireObject(manifest.source, 'manifest.source')
  requireString(source.package, 'manifest.source.package')
  requireString(source.version, 'manifest.source.version')
  const runtime = requireObject(manifest.runtime, 'manifest.runtime')
  const libraries = new Set([validateLibraryName(runtime.library, 'manifest.runtime.library')])
  const languages = new Set()
  if (!Array.isArray(manifest.grammars) || manifest.grammars.length === 0) {
    throw new Error('manifest.grammars must be a non-empty array')
  }
  manifest.grammars.forEach((grammarValue, grammarIndex) => {
    const label = `manifest.grammars[${grammarIndex}]`
    const grammar = requireObject(grammarValue, label)
    const library = validateLibraryName(grammar.library, `${label}.library`)
    if (libraries.has(library)) throw new Error(`${label}.library duplicates ${library}`)
    libraries.add(library)
    if (!Array.isArray(grammar.languages) || grammar.languages.length === 0) {
      throw new Error(`${label}.languages must be a non-empty array`)
    }
    grammar.languages.forEach((languageValue, languageIndex) => {
      const languageLabel = `${label}.languages[${languageIndex}]`
      const language = requireObject(languageValue, languageLabel)
      const id = requireString(language.id, `${languageLabel}.id`)
      if (!/^[a-z][a-z0-9-]*$/.test(id) || languages.has(id)) {
        throw new Error(`${languageLabel}.id is invalid or duplicated: ${id}`)
      }
      languages.add(id)
      const entryPoint = requireString(language.entryPoint, `${languageLabel}.entryPoint`)
      if (!/^tree_sitter_[a-z0-9_]+$/.test(entryPoint)) {
        throw new Error(`${languageLabel}.entryPoint is invalid: ${entryPoint}`)
      }
    })
  })
  return manifest
}

export function loadGrammarManifest(manifestPath = grammarManifestPath) {
  return validateGrammarManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
}

export function requiredGrammarLibraries(manifest) {
  return {
    runtime: manifest.runtime.library,
    grammars: manifest.grammars.map((grammar) => grammar.library)
  }
}

export function nativeLibraryFileName(library, rid) {
  if (/^win-(?:x64|arm64)$/.test(rid)) return `${library}.dll`
  if (/^osx-(?:x64|arm64)$/.test(rid)) return `lib${library}.dylib`
  if (/^linux-(?:x64|arm64)$/.test(rid)) return `lib${library}.so`
  throw new Error(`unsupported CodeGraph grammar RID: ${rid}`)
}

export function resolveGrammarFiles(sourceDir, rid, manifest) {
  const expected = [manifest.runtime.library, ...manifest.grammars.map((item) => item.library)].map(
    (library) => ({ library, file: nativeLibraryFileName(library, rid) })
  )
  const available = new Set(readdirSync(sourceDir))
  const missing = expected.filter(({ file }) => !available.has(file))
  if (missing.length > 0) {
    throw new Error(
      `missing required ${rid} native libraries: ${missing.map(({ file }) => file).join(', ')}`
    )
  }
  return expected.map((item) => ({ ...item, absolutePath: join(sourceDir, item.file) }))
}

function symbolToolCandidates(rid, file) {
  if (rid.startsWith('osx-')) {
    return [
      { command: 'nm', args: ['-gU', file] },
      { command: 'llvm-nm', args: ['--extern-only', '--defined-only', file] },
      { command: 'objdump', args: ['--syms', file] }
    ]
  }
  if (rid.startsWith('linux-')) {
    return [
      { command: 'nm', args: ['-D', '--defined-only', file] },
      { command: 'llvm-nm', args: ['--dynamic', '--extern-only', '--defined-only', file] },
      { command: 'objdump', args: ['-T', file] }
    ]
  }
  if (rid.startsWith('win-')) {
    return [
      { command: 'dumpbin', args: ['/nologo', '/exports', file] },
      { command: 'llvm-nm', args: ['--extern-only', '--defined-only', file] },
      { command: 'objdump', args: ['-p', file] }
    ]
  }
  throw new Error(`unsupported CodeGraph grammar RID: ${rid}`)
}

function inspectNativeSymbols(file, rid) {
  const attempts = []
  for (const candidate of symbolToolCandidates(rid, file)) {
    const result = spawnSync(candidate.command, candidate.args, {
      encoding: 'utf8',
      windowsHide: true
    })
    if (result.error?.code === 'ENOENT') {
      attempts.push(`${candidate.command}: not found`)
      continue
    }
    if (result.error || result.status !== 0) {
      attempts.push(
        `${candidate.command}: ${result.error?.message ?? result.stderr ?? result.status}`
      )
      continue
    }
    return { tool: candidate.command, output: `${result.stdout}\n${result.stderr}` }
  }
  throw new Error(`cannot inspect exports for ${file} (${rid}): ${attempts.join('; ')}`)
}

function hasExportedSymbol(output, entryPoint) {
  const escaped = entryPoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^A-Za-z0-9_])_?${escaped}(?:$|[^A-Za-z0-9_])`, 'm').test(output)
}

export function validateGrammarEntryPoints(sourceDir, rid, manifest) {
  const files = resolveGrammarFiles(sourceDir, rid, manifest)
  const filesByLibrary = new Map(files.map((file) => [file.library, file]))
  return manifest.grammars.map((grammar) => {
    const nativeLibrary = filesByLibrary.get(grammar.library)
    const symbols = inspectNativeSymbols(join(sourceDir, nativeLibrary.file), rid)
    const entryPoints = [...new Set(grammar.languages.map((language) => language.entryPoint))]
    const missing = entryPoints.filter(
      (entryPoint) => !hasExportedSymbol(symbols.output, entryPoint)
    )
    if (missing.length > 0) {
      throw new Error(`${nativeLibrary.file} does not export ${missing.join(', ')}`)
    }
    return { library: grammar.library, file: nativeLibrary.file, entryPoints, tool: symbols.tool }
  })
}
