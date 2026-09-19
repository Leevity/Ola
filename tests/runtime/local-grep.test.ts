import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canUseTsLocalGrep, grepLocalFiles } from '../../src/runtime/host/local-grep'

describe('TS local grep adapter', () => {
  async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ola-local-grep-'))
    await writeFile(join(root, 'first.ts'), 'const alpha = 1\nconst beta = alpha\n', 'utf8')
    await writeFile(join(root, 'second.md'), 'Alpha heading\ncontext line\nalpha ending\n', 'utf8')
    return root
  }

  it('returns structured bounded matches with relative paths and columns', async () => {
    const root = await fixture()
    try {
      const result = await grepLocalFiles({
        path: root,
        pattern: 'alpha',
        caseSensitive: false,
        column: true
      })
      expect(result.error).toBeUndefined()
      expect(result.meta.engine).toBe('node')
      expect(result.matches).toContainEqual(
        expect.objectContaining({ path: 'first.ts', line: 1, column: 7, kind: 'match' })
      )
      expect(result.output).toContain('first.ts:1:7:const alpha = 1')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('supports AND/not patterns, path filters, context and count mode', async () => {
    const root = await fixture()
    try {
      const filtered = await grepLocalFiles({
        path: root,
        patterns: ['alpha', 'beta'],
        patternOperator: 'and',
        include: '*.ts'
      })
      expect(filtered.matches).toHaveLength(1)
      expect(filtered.matches[0]).toMatchObject({ path: 'first.ts', line: 2 })
      const contextual = await grepLocalFiles({
        path: root,
        pattern: 'alpha ending',
        beforeContext: 1
      })
      expect(contextual.matches.map((match) => match.kind)).toEqual(['context', 'match'])
      const counted = await grepLocalFiles({
        path: root,
        pattern: 'alpha',
        caseSensitive: false,
        outputMode: 'count'
      })
      expect(counted.output).toContain('first.ts:2')
      expect(counted.output).toContain('second.md:2')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns each non-empty matched fragment when onlyMatching is selected', async () => {
    const root = await fixture()
    try {
      const result = await grepLocalFiles({
        path: root,
        pattern: 'alpha',
        caseSensitive: false,
        onlyMatching: true,
        column: true
      })
      expect(result.matches).toContainEqual(
        expect.objectContaining({ path: 'first.ts', line: 1, column: 7, text: 'alpha' })
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps semantically unsupported Git and parser options on the legacy path', () => {
    expect(canUseTsLocalGrep({ pattern: 'alpha', pathspec: 'src/**' })).toBe(false)
    expect(canUseTsLocalGrep({ pattern: 'alpha', multiline: true })).toBe(false)
    expect(canUseTsLocalGrep({ pattern: 'alpha', patternMode: 'basic' })).toBe(false)
    expect(canUseTsLocalGrep({ pattern: 'alpha', text: true })).toBe(false)
    expect(canUseTsLocalGrep({ pattern: 'alpha', followSymlinks: true })).toBe(false)
    expect(canUseTsLocalGrep({ pattern: 'alpha', type: 'ts' })).toBe(false)
    expect(canUseTsLocalGrep({ pattern: 'alpha', onlyMatching: true })).toBe(true)
  })

  it('applies result and byte limits without emitting oversized output', async () => {
    const root = await fixture()
    try {
      const result = await grepLocalFiles({
        path: root,
        pattern: 'alpha',
        caseSensitive: false,
        maxResults: 1
      })
      expect(result.matches).toHaveLength(1)
      expect(result.meta).toMatchObject({ truncated: true, limitReason: 'max_results' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
