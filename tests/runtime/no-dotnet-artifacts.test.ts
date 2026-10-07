import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPackage } from '@electron/asar'

const roots: string[] = []
const script = resolve(import.meta.dirname, '../../scripts/verify-legacy-artifacts.mjs')

afterEach(() => {
  const tempRoot = resolve(tmpdir())
  for (const root of roots.splice(0)) {
    const target = resolve(root)
    if (
      !target.startsWith(`${tempRoot}${sep}`) ||
      !basename(target).startsWith('ola-no-dotnet-artifacts-')
    ) {
      throw new Error(`Unexpected legacy scan fixture path: ${target}`)
    }
    rmSync(target, { recursive: true, force: true })
  }
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'ola-no-dotnet-artifacts-'))
  roots.push(root)
  return root
}

describe('release artifact .NET gate', () => {
  it('accepts TS workers and WASM assets', () => {
    const root = fixture()
    mkdirSync(join(root, 'resources'), { recursive: true })
    writeFileSync(join(root, 'resources', 'business-worker.mjs'), '')
    writeFileSync(join(root, 'resources', 'tree-sitter.wasm'), '')
    expect(() => execFileSync(process.execPath, [script, root])).not.toThrow()
  })

  it.each(['Ola.Native.Worker.exe', 'Ola.CodeGraph.Worker', 'Ola.CodeGraph.Core.dll'])(
    'rejects %s',
    (name) => {
      const root = fixture()
      writeFileSync(join(root, name), '')
      expect(() => execFileSync(process.execPath, [script, root], { stdio: 'pipe' })).toThrow()
    }
  )

  it('rejects a legacy Worker hidden inside app.asar', async () => {
    const root = fixture()
    const source = join(root, 'source')
    const output = join(root, 'output')
    mkdirSync(source)
    mkdirSync(output)
    writeFileSync(join(source, 'Ola.Native.Worker.exe'), '')
    await createPackage(source, join(output, 'app.asar'))
    expect(() => execFileSync(process.execPath, [script, output], { stdio: 'pipe' })).toThrow(
      /legacy runtime artifact/
    )
  })
})
