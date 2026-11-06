import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPackage } from '@electron/asar'
import { packagedCodegraphGrammarNames } from '../../scripts/stage-codegraph-grammars.mjs'

const roots: string[] = []
const script = resolve(import.meta.dirname, '../../scripts/verify-runtime-staging.mjs')
const agentDesktopLock = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../resources/agent-desktop.lock.json'), 'utf8')
) as {
  platforms: Record<string, { cli: string; binaries: Record<string, { size: number }> }>
}

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

type AgentDesktopFixture = {
  platform?: 'darwin' | 'linux' | 'win32'
  missingBinary?: boolean
  foreignTriple?: string
  nonExecutable?: boolean
}

function agentDesktopTripleKey(platform: 'darwin' | 'linux' | 'win32'): string {
  return `${platform}-${process.arch}`
}

async function fixture(
  withSourceMap: boolean,
  legacyArtifactPath?: string,
  missingCodegraphWasm?: 'runtime' | 'grammar',
  agentDesktop?: AgentDesktopFixture
): Promise<string> {
  const platform = agentDesktop?.platform ?? 'win32'
  const root = mkdtempSync(join(tmpdir(), 'ola-staging-'))
  roots.push(root)
  const packageRoot = join(root, 'package')
  const appRoot = join(root, 'win-unpacked')
  const resourceRoot = join(appRoot, 'resources')
  const workers = join(resourceRoot, 'app.asar.unpacked', 'out', 'main')
  mkdirSync(join(packageRoot, 'out', 'runtime'), { recursive: true })
  mkdirSync(workers, { recursive: true })
  writeFileSync(join(appRoot, 'ola.exe'), '')
  writeFileSync(join(appRoot, 'ola'), '')
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
  const agentDesktopKey = agentDesktopTripleKey(platform)
  const agentDesktopEntry = agentDesktopLock.platforms[agentDesktopKey]
  const agentDesktopRoot = join(resourceRoot, 'app.asar.unpacked', 'resources', 'agent-desktop')
  mkdirSync(agentDesktopRoot, { recursive: true })
  writeFileSync(join(agentDesktopRoot, 'NOTICE.md'), '# agent-desktop binaries\n')
  if (agentDesktopEntry && !agentDesktop?.missingBinary) {
    const binaryDir = join(agentDesktopRoot, agentDesktopKey)
    mkdirSync(binaryDir, { recursive: true })
    for (const name of Object.keys(agentDesktopEntry.binaries)) {
      const binary = join(binaryDir, name)
      writeFileSync(binary, '')
      chmodSync(binary, agentDesktop?.nonExecutable ? 0o644 : 0o755)
    }
  }
  if (agentDesktop?.foreignTriple) {
    const foreignDir = join(agentDesktopRoot, agentDesktop.foreignTriple)
    mkdirSync(foreignDir, { recursive: true })
    writeFileSync(join(foreignDir, 'agent-desktop'), '')
  }
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
  it.each([
    'tools/design-review/main.tsx',
    'tests/fixture.json',
    'scripts/dev.mjs',
    'docs/review.md'
  ])('rejects packaged development source %s', async (path) => {
    const root = await fixture(false, path)
    expect(() =>
      execFileSync(process.execPath, [script, root, '--platform=win32'], { stdio: 'pipe' })
    ).toThrow(/development source/)
  })
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

  it('rejects a package without the agent-desktop CLI for the build triple', async () => {
    const root = await fixture(false, undefined, undefined, { missingBinary: true })
    expect(() =>
      execFileSync(process.execPath, [script, root, '--platform=win32'], { stdio: 'pipe' })
    ).toThrow(/agent-desktop/)
  })

  it('rejects a package that also ships a foreign architecture triple', async () => {
    const foreign = agentDesktopTripleKey('win32') === 'win32-x64' ? 'win32-arm64' : 'win32-x64'
    const root = await fixture(false, undefined, undefined, { foreignTriple: foreign })
    expect(() =>
      execFileSync(process.execPath, [script, root, '--platform=win32'], { stdio: 'pipe' })
    ).toThrow(new RegExp(`must ship exactly ${agentDesktopTripleKey('win32')}`))
  })

  it('rejects a known triple that the lock does not pin', async () => {
    const root = await fixture(false, undefined, undefined, { platform: 'win32' })
    expect(() =>
      execFileSync(process.execPath, [script, root, '--platform=win32', '--arch=ppc64'], {
        stdio: 'pipe'
      })
    ).toThrow(/agent-desktop/)
  })

  it.runIf(process.platform !== 'win32')(
    'rejects an agent-desktop binary that lost its executable bit',
    async () => {
      const root = await fixture(false, undefined, undefined, {
        platform: 'linux',
        nonExecutable: true
      })
      expect(() =>
        execFileSync(process.execPath, [script, root, '--platform=linux'], { stdio: 'pipe' })
      ).toThrow(/not executable/)
    }
  )
})
