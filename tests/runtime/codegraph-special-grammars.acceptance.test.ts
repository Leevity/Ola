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

describe('TS CodeGraph special grammar acceptance', () => {
  it.each([
    ['haskell', 'module App where\nrun value = value\n', 'run', 'value'],
    ['julia', 'module App\nfunction run(value)\n  return value\nend\nend\n', 'run', 'value'],
    [
      'razor',
      '@page "/"\n@code {\n    string title = "Hello";\n}\n<h1>@title</h1>\n',
      'title',
      'title'
    ]
  ] as const)(
    '%s exposes declarations and references through the TS indexer',
    async (language, source, symbol, reference) => {
      const result = await indexWithWasm(language, source)
      expect(result.hasParseError).toBe(false)
      expect(result.symbols).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: symbol })])
      )
      expect(result.references).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: reference })])
      )
    }
  )

  it('incrementally reindexes and removes Haskell, Julia and Razor files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-codegraph-special-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const files = {
      'app.hs': 'module App where\nrun value = value\n',
      'app.jl': 'module App\nfunction run(value)\n  return value\nend\nend\n',
      'page.razor': '@code {\n    string title = "Hello";\n}\n<h1>@title</h1>\n'
    }
    for (const [path, source] of Object.entries(files)) await writeFile(join(root, path), source)
    const store = new WasmCodeGraphStore(join(root, 'graph.db'))
    cleanup.push(() => store.close())

    await expect(indexWorkspaceWithWasm({ root, store })).resolves.toMatchObject({
      indexed: 3,
      errors: [],
      unsupported: []
    })
    expect(await store.findSymbols('run')).toHaveLength(2)
    expect(await store.findSymbols('title')).toEqual([
      expect.objectContaining({ path: 'page.razor', language: 'razor' })
    ])

    await writeFile(join(root, 'app.hs'), 'module App where\nexecute value = value\n')
    await expect(indexWorkspaceWithWasm({ root, store })).resolves.toMatchObject({ indexed: 1 })
    expect(await store.findSymbols('run')).toHaveLength(1)
    expect(await store.findSymbols('execute')).toEqual([
      expect.objectContaining({ path: 'app.hs', language: 'haskell' })
    ])

    await rm(join(root, 'app.jl'))
    await expect(indexWorkspaceWithWasm({ root, store })).resolves.toMatchObject({ removed: 1 })
    expect(await store.getFile('app.jl')).toBeNull()
  })

  it('indexes the three special grammars within the acceptance performance budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-codegraph-special-perf-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const source = [
      'module App where\nrun value = value\n',
      'module App\nfunction run(value)\n  return value\nend\nend\n',
      '@code {\n    string title = "Hello";\n}\n<h1>@title</h1>\n'
    ]
    await writeFile(join(root, 'app.hs'), source[0])
    await writeFile(join(root, 'app.jl'), source[1])
    await writeFile(join(root, 'page.razor'), source[2])
    const store = new WasmCodeGraphStore(join(root, 'graph.db'))
    cleanup.push(() => store.close())

    const startedAt = performance.now()
    const result = await indexWorkspaceWithWasm({ root, store })
    const elapsedMs = performance.now() - startedAt
    expect(result).toMatchObject({ indexed: 3, errors: [], unsupported: [] })
    expect(elapsedMs).toBeLessThan(5000)
  })
})
