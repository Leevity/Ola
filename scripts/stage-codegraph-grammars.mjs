/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// Keep this list in sync with the package-backed grammar names in wasm-parser.ts.
export const packagedCodegraphGrammarNames = [
  'typescript',
  'tsx',
  'javascript',
  'python',
  'go',
  'java',
  'c_sharp',
  'rust',
  'c',
  'cpp',
  'php',
  'ruby',
  'scala',
  'bash',
  'kotlin',
  'swift',
  'objc',
  'lua',
  'solidity',
  'dart'
]

export async function stageCodegraphGrammars(sourceRoot, stagingRoot) {
  const destination = join(stagingRoot, 'resources', 'codegraph', 'grammars')
  await mkdir(destination, { recursive: true })
  for (const grammar of packagedCodegraphGrammarNames) {
    const filename = `tree-sitter-${grammar}.wasm`
    await cp(
      join(sourceRoot, 'node_modules', 'tree-sitter-wasms', 'out', filename),
      join(destination, filename)
    )
  }
}
