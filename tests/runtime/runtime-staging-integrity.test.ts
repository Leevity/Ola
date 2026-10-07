import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPackage } from '@electron/asar'
import { packagedCodegraphGrammarNames } from '../../scripts/stage-codegraph-grammars.mjs'

const roots: string[] = []
const script = resolve(import.meta.dirname, '../../scripts/verify-runtime-staging.mjs')

afterEach(() => {
  const tempRoot = resolve(tmpdir())
  for (const root of roots.splice(0)) {
    const target = resolve(root)
    if (!target.startsWith(`${tempRoot}${sep}`) || !basename(target).startsWith('ola-staging-')) {
      throw new Error(`Unexpected staging fixture path: ${target}`)
    }
    rmSync(target, { recursive: true, force: true })
  }
})

async function fixture(
  withSourceMap: boolean,
  legacyArtifactPath?: string,
  missingCodegraphWasm?: 'runtime' | 'grammar'
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'ola-staging-'))
  roots.push(root)
  const packageRoot = join(root, 'package')
  const appRoot = join(root, 'win-unpacked')
  const resourceRoot = join(appRoot, 'resources')
  const workers = join(resourceRoot, 'app.asar.unpacked', 'out', 'main')
  mkdirSync(join(packageRoot, 'out', 'runtime'), { recursive: true })
  mkdirSync(workers, { recursive: true })
  writeFileSync(join(appRoot, 'ola.exe'), '')
  writeFileSync(join(workers, 'business-worker.mjs'), '')
  writeFileSync(join(workers, 'graph-store-worker.mjs'), '')
  const unpackedModules = join(resourceRoot, 'app.asar.unpacked', 'node_modules')
  if (missingCodegraphWasm !== 'runtime') {
    const runtimeWasm = join(unpackedModules, 'web-tree-sitter', 'tree-sitter.wasm')
    mkdirSync(dirname(runtimeWasm), { recursive: true })
    writeFileSync(runtimeWasm, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
  }
  for (const grammar of packagedCodegraphGrammarNames) {
    if (missingCodegraphWasm === 'grammar' && grammar === 'typescript') continue
    const grammarWasm = join(
      resourceRoot,
      'app.asar.unpacked',
      'resources',
      'codegraph',
      'grammars',
      `tree-sitter-${grammar}.wasm`
    )
    mkdirSync(dirname(grammarWasm), { recursive: true })
    writeFileSync(grammarWasm, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
  }
  writeFileSync(join(packageRoot, 'out', 'runtime', 'cli.mjs'), 'export {}')
  if (withSourceMap) {
    writeFileSync(join(packageRoot, 'out', 'runtime', 'cli.mjs.map'), '{}')
  }
  if (legacyArtifactPath) {
    const target = join(packageRoot, legacyArtifactPath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, '')
  }
  await createPackage(packageRoot, join(resourceRoot, 'app.asar'))
  return appRoot
}

describe('runtime staging integrity', () => {
  it('accepts a package without source maps', async () => {
    const root = await fixture(false)
    expect(() =>
      execFileSync(process.execPath, [script, root, '--platform=win32'], { stdio: 'pipe' })
    ).not.toThrow()
  })

  it('rejects packaged source maps', async () => {
    const root = await fixture(true)
    expect(() =>
      execFileSync(process.execPath, [script, root, '--platform=win32'], { stdio: 'pipe' })
    ).toThrow(/source maps/)
  })

  it.each(['runtime', 'grammar'] as const)(
    'rejects a package missing CodeGraph %s WASM',
    async (missingCodegraphWasm) => {
      const root = await fixture(false, undefined, missingCodegraphWasm)
      expect(() =>
        execFileSync(process.execPath, [script, root, '--platform=win32'], { stdio: 'pipe' })
      ).toThrow(/tree-sitter.*\.wasm/)
    }
  )

  it.each([
    'resources/native-worker/worker.bin',
    'resources/Ola.Native.Worker.exe',
    'resources/hostfxr.dll'
  ])('rejects packaged legacy artifact %s', async (path) => {
    const root = await fixture(false, path)
    expect(() =>
      execFileSync(process.execPath, [script, root, '--platform=win32'], { stdio: 'pipe' })
    ).toThrow(/legacy runtime artifacts in app\.asar/)
  })
})
