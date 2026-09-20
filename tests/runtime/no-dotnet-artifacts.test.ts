import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const script = resolve(import.meta.dirname, '../../scripts/verify-legacy-artifacts.mjs')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
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
})
