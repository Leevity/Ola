import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WasmCodeGraphStore } from '../../src/runtime/codegraph/graph-store'
import {
  indexWorkspaceWithWasm,
  languageForCodeGraphPath
} from '../../src/runtime/codegraph/workspace-indexer'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

describe('TS CodeGraph workspace indexer', () => {
  it('indexes supported source files and excludes generated, dependency and symlink paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-workspace-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(root, 'src', 'index.ts'), 'export function workspace() {}')
    await writeFile(join(root, 'node_modules', 'pkg', 'ignored.ts'), 'export function ignored() {}')
    await writeFile(join(root, 'README.md'), '# ignored')
    await symlink(join(root, 'src', 'index.ts'), join(root, 'linked.ts'))
    const store = new WasmCodeGraphStore(join(root, 'graph.db'))
    cleanup.push(() => store.close())
    await expect(indexWorkspaceWithWasm({ root, store })).resolves.toMatchObject({ indexed: 1 })
    expect(await store.findSymbols('workspace')).toEqual([
      expect.objectContaining({ path: 'src/index.ts', exported: true })
    ])
    expect(await store.findSymbols('ignored')).toEqual([])
    await expect(indexWorkspaceWithWasm({ root, store })).resolves.toMatchObject({ indexed: 0 })
    await writeFile(join(root, 'src', 'index.ts'), 'export function changed() {}')
    await expect(indexWorkspaceWithWasm({ root, store })).resolves.toMatchObject({ indexed: 1 })
    expect(await store.findSymbols('workspace')).toEqual([])
    expect(await store.findSymbols('changed')).toEqual([
      expect.objectContaining({ path: 'src/index.ts' })
    ])
    await unlink(join(root, 'src', 'index.ts'))
    await expect(indexWorkspaceWithWasm({ root, store })).resolves.toMatchObject({ removed: 1 })
    expect(await store.findSymbols('changed')).toEqual([])
  })

  it('indexes Solidity and reports grammars that are deliberately unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-workspace-extra-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'token.sol'), 'contract Token { function mint() public {} }')
    await writeFile(join(root, 'legacy.rb'), 'class Legacy; end')
    await writeFile(join(root, 'mobile.dart'), 'class Mobile {}')
    await writeFile(join(root, 'legacy.hs'), 'module App where\nrun = pure ()')
    await writeFile(join(root, 'legacy.jl'), 'module App\nrun() = nothing\nend')
    await writeFile(join(root, 'page.razor'), '@page "/"\n<h1>@title</h1>')
    const store = new WasmCodeGraphStore(join(root, 'graph.db'))
    cleanup.push(() => store.close())
    const result = await indexWorkspaceWithWasm({ root, store })
    expect(result.errors).toEqual([])
    expect(result).toMatchObject({ indexed: 6 })
    expect(result.unsupported).toEqual([])
    await expect(store.getFile('token.sol')).resolves.toMatchObject({ language: 'solidity' })
  })

  it('maps only explicit grammar extensions', () => {
    expect(languageForCodeGraphPath('app.tsx')).toBe('tsx')
    expect(languageForCodeGraphPath('script.py')).toBe('python')
    expect(languageForCodeGraphPath('mobile.kt')).toBe('kotlin')
    expect(languageForCodeGraphPath('App.swift')).toBe('swift')
    expect(languageForCodeGraphPath('mobile.dart')).toBe('dart')
    expect(languageForCodeGraphPath('legacy.hs')).toBe('haskell')
    expect(languageForCodeGraphPath('legacy.jl')).toBe('julia')
    expect(languageForCodeGraphPath('View.razor')).toBe('razor')
    expect(languageForCodeGraphPath('Token.sol')).toBe('solidity')
    expect(languageForCodeGraphPath('legacy.rb')).toBe('ruby')
    expect(languageForCodeGraphPath('README.md')).toBeNull()
  })
})
