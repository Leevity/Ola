import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WasmCodeGraphStore } from '../../src/runtime/codegraph/graph-store'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

describe('TS CodeGraph SQLite store', () => {
  it('atomically replaces a file index and finds symbols without leaking stale declarations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ola-codegraph-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const store = new WasmCodeGraphStore(join(dir, 'graph.db'))
    cleanup.push(() => store.close())
    await store.indexFile({
      path: 'src/helpers.ts',
      language: 'typescript',
      source: 'export const helpers = {}'
    })
    await store.indexFile({
      path: 'src/workspace.ts',
      language: 'typescript',
      source:
        "import { packageApi } from 'package-api'\nimport { helpers } from './helpers'\nexport function choose() {}\nconst oldValue = 1"
    })
    expect(await store.findSymbols('choose')).toEqual([
      expect.objectContaining({ path: 'src/workspace.ts', exported: true })
    ])
    await expect(store.searchSymbols('cho')).resolves.toEqual([
      expect.objectContaining({ name: 'choose', path: 'src/workspace.ts' })
    ])
    await expect(store.getImports('src/workspace.ts')).resolves.toEqual([
      expect.objectContaining({ source: 'package-api', startLine: 1 }),
      expect.objectContaining({ source: './helpers', startLine: 2 })
    ])
    await expect(store.resolveImports('src/workspace.ts')).resolves.toEqual([
      expect.objectContaining({ source: 'package-api', targetPath: null }),
      expect.objectContaining({ source: './helpers', targetPath: 'src/helpers.ts' })
    ])
    await expect(store.findReferences('helpers')).resolves.toEqual([
      expect.objectContaining({ path: 'src/workspace.ts', name: 'helpers', language: 'typescript' })
    ])
    await store.indexFile({
      path: 'src/workspace.ts',
      language: 'typescript',
      source: "import { next } from './next'\nexport class Workspace {}"
    })
    expect(await store.findSymbols('choose')).toEqual([])
    expect(await store.findReferences('helpers')).toEqual([])
    await expect(store.getFile('src/workspace.ts')).resolves.toMatchObject({
      language: 'typescript',
      hasParseError: false,
      symbols: [expect.objectContaining({ name: 'Workspace', kind: 'class', exported: true })],
      imports: [expect.objectContaining({ source: './next' })]
    })
  })
})
