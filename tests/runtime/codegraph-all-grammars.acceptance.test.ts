import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WasmCodeGraphStore } from '../../src/runtime/codegraph/graph-store'
import { indexWithWasm } from '../../src/runtime/codegraph/wasm-indexer'
import { indexWorkspaceWithWasm } from '../../src/runtime/codegraph/workspace-indexer'

const cleanup: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const fixtures = [
  ['typescript', '.ts', 'export function run(value: string): string { return value }'],
  ['tsx', '.tsx', 'export function App() { return <div /> }'],
  ['javascript', '.js', 'function run(value) { return value }'],
  ['jsx', '.jsx', 'function App() { return <div /> }'],
  ['python', '.py', 'def run(value):\n    return value\n'],
  ['go', '.go', 'package main\nfunc run(value string) string { return value }'],
  ['java', '.java', 'class App { String run(String value) { return value; } }'],
  ['csharp', '.cs', 'class App { string Run(string value) { return value; } }'],
  ['rust', '.rs', 'fn run(value: &str) -> &str { value }'],
  ['c', '.c', 'int run(int value) { return value; }'],
  ['cpp', '.cpp', 'int run(int value) { return value; }'],
  ['php', '.php', '<?php function run($value) { return $value; }'],
  ['ruby', '.rb', 'def run(value)\n  value\nend\n'],
  ['scala', '.scala', 'def run(value: String): String = value'],
  ['bash', '.sh', 'run() { local value="$1"; echo "$value"; }'],
  ['haskell', '.hs', 'module App where\nrun value = value\n'],
  ['julia', '.jl', 'module App\nfunction run(value)\n  return value\nend\nend\n'],
  ['razor', '.razor', '@code {\n    string title = "Hello";\n}\n<h1>@title</h1>\n']
] as const

describe('TS/WASM CodeGraph all-language acceptance', () => {
  it.each(fixtures)(
    '%s parses a fixed declaration/reference corpus',
    async (language, _ext, source) => {
      const result = await indexWithWasm(language, source)
      expect(result.hasParseError).toBe(false)
      expect(result.symbols.length).toBeGreaterThan(0)
      expect(result.references.length).toBeGreaterThan(0)
    }
  )

  it('supports incremental rewrite and deletion for every configured grammar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-codegraph-all-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    for (const [language, extension, source] of fixtures)
      await writeFile(join(root, `sample-${language}${extension}`), source)
    const store = new WasmCodeGraphStore(join(root, 'graph.db'))
    cleanup.push(() => store.close())

    await expect(indexWorkspaceWithWasm({ root, store })).resolves.toMatchObject({
      indexed: fixtures.length,
      errors: [],
      unsupported: []
    })
    expect(await store.findSymbols('run')).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'run' })])
    )

    for (const [_language, extension, source] of fixtures)
      await writeFile(join(root, `sample-${_language}${extension}`), `${source}\n`)
    await expect(indexWorkspaceWithWasm({ root, store })).resolves.toMatchObject({
      indexed: fixtures.length,
      errors: [],
      unsupported: []
    })
    expect(await store.findSymbols('run')).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'run' })])
    )

    for (const [language, extension] of fixtures)
      await rm(join(root, `sample-${language}${extension}`))
    await expect(indexWorkspaceWithWasm({ root, store })).resolves.toMatchObject({
      removed: fixtures.length
    })
    expect(await store.listPaths()).toEqual([])
  })

  it('keeps the full configured grammar corpus within the performance budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-codegraph-all-perf-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    for (const [language, extension, source] of fixtures)
      await writeFile(join(root, `sample-${language}${extension}`), source)
    const store = new WasmCodeGraphStore(join(root, 'graph.db'))
    cleanup.push(() => store.close())

    const startedAt = performance.now()
    const result = await indexWorkspaceWithWasm({ root, store })
    const elapsedMs = performance.now() - startedAt
    expect(result).toMatchObject({ indexed: fixtures.length, errors: [], unsupported: [] })
    expect(elapsedMs).toBeLessThan(15_000)
  })
})
