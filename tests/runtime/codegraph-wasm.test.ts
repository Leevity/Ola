import { describe, expect, it } from 'vitest'
import { getWasmGrammarStatus, parseWithWasm } from '../../src/runtime/codegraph/wasm-parser'
import { indexWithWasm } from '../../src/runtime/codegraph/wasm-indexer'

describe('TS CodeGraph WASM parser foundation', () => {
  it.each([
    'typescript',
    'tsx',
    'javascript',
    'jsx',
    'python',
    'go',
    'java',
    'csharp',
    'rust',
    'c',
    'cpp',
    'php',
    'scala',
    'bash',
    'kotlin',
    'swift',
    'objectivec',
    'lua',
    'solidity'
  ] as const)('has a pinned WASM grammar for %s', (language) => {
    expect(getWasmGrammarStatus(language)).toBe('available')
  })
  it.each(['haskell', 'julia', 'razor', 'ruby', 'dart'] as const)(
    'reports the unavailable %s grammar explicitly',
    (language) => {
      expect(getWasmGrammarStatus(language)).toBe('unavailable')
    }
  )
  it.each(['haskell', 'julia', 'razor', 'ruby', 'dart'] as const)(
    'rejects parsing when the %s grammar is unavailable',
    async (language) => {
      await expect(parseWithWasm(language, 'placeholder')).rejects.toThrow(
        `CODEGRAPH_GRAMMAR_UNAVAILABLE:${language}`
      )
    }
  )

  it('parses TypeScript in-process and releases its parser tree', async () => {
    await expect(
      parseWithWasm('typescript', 'export function add(a: number, b: number) { return a + b }')
    ).resolves.toMatchObject({ rootType: 'program', hasError: false })
  })

  it.each([
    ['javascript', 'const value = 1'],
    ['jsx', 'const App = () => <main />'],
    ['tsx', 'const App = (): JSX.Element => <main />'],
    ['python', 'value = 1'],
    ['go', 'package main\nfunc main() {}'],
    ['java', 'class App {}'],
    ['csharp', 'class App {}'],
    ['rust', 'fn main() {}'],
    ['c', 'int main() { return 0; }'],
    ['cpp', 'int main() { return 0; }'],
    ['php', '<?php echo 1;'],
    ['scala', 'object App {}'],
    ['bash', 'echo hello'],
    ['kotlin', 'fun main() { println("hello") }'],
    ['swift', 'final class App { func run() {} }'],
    ['objectivec', '@interface App : NSObject @end'],
    ['lua', 'local function run() end']
  ] as const)('loads and parses a %s grammar in-process', async (language, source) => {
    await expect(parseWithWasm(language, source)).resolves.toMatchObject({ hasError: false })
  })
  it('extracts Solidity contract declarations as queryable class symbols', async () => {
    await expect(
      indexWithWasm('solidity', 'contract Token { function mint() public {} }')
    ).resolves.toMatchObject({
      hasParseError: false,
      symbols: expect.arrayContaining([
        expect.objectContaining({ name: 'Token', kind: 'class', startLine: 1 }),
        expect.objectContaining({ name: 'mint', kind: 'function', startLine: 1 })
      ])
    })
  })

  it('does not silently accept malformed source as a complete parse', async () => {
    await expect(parseWithWasm('typescript', 'export function {')).resolves.toMatchObject({
      hasError: true
    })
  })

  it('extracts file-local declarations with stable source positions', async () => {
    await expect(
      indexWithWasm(
        'typescript',
        [
          'export class Workspace {',
          '  run(): void {}',
          '}',
          "import { schedule } from './schedule'",
          'export function schedule(): void {}',
          'const internal = 1'
        ].join('\n')
      )
    ).resolves.toMatchObject({
      hasParseError: false,
      symbols: [
        { name: 'Workspace', kind: 'class', startLine: 1, exported: true },
        { name: 'run', kind: 'method', startLine: 2 },
        { name: 'schedule', kind: 'function', startLine: 5, exported: true },
        { name: 'internal', kind: 'variable', startLine: 6 }
      ],
      imports: [{ source: './schedule', startLine: 4 }],
      references: expect.arrayContaining([
        expect.objectContaining({ name: 'schedule', startLine: 4 })
      ])
    })
  })
})
