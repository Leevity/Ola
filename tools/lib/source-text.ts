import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// These gates assert on code, not on layout. The formatter owns the whitespace, so
// every comparison here collapses whitespace runs on both sides: a reformat cannot
// turn a gate red. Collapsing never drops a token, so counts and ordering keep their
// meaning. Line-anchored patterns are the exception — use assertRawMatch for those.

export async function readSource(relativePath: string): Promise<string> {
  const text = await readFile(path.join(process.cwd(), relativePath), 'utf8')
  return text.replace(/^\uFEFF/, '')
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ')
}

// For gates whose every assertion is whitespace-agnostic: collapsing once at read time
// decouples all of them without touching each call site. Only safe when no pattern is
// line-anchored — those gates must use assertRawMatch on readSource() instead.
export async function readCollapsedSource(relativePath: string): Promise<string> {
  return collapseWhitespace(await readSource(relativePath))
}

export function assertIncludes(source: string, needle: string, label: string): void {
  assert.ok(
    collapseWhitespace(source).includes(collapseWhitespace(needle)),
    `${label}: expected to contain ${JSON.stringify(needle)}`
  )
}

export function assertNotIncludes(source: string, needle: string, label: string): void {
  assert.ok(
    !collapseWhitespace(source).includes(collapseWhitespace(needle)),
    `${label}: must not contain ${JSON.stringify(needle)}`
  )
}

export function assertCount(source: string, needle: string, expected: number, label: string): void {
  const haystack = collapseWhitespace(source)
  const target = collapseWhitespace(needle)
  assert.ok(target.length > 0, `${label}: needle must not be empty`)
  const actual = haystack.split(target).length - 1
  assert.equal(
    actual,
    expected,
    `${label}: expected ${expected} occurrence(s) of ${JSON.stringify(needle)}, found ${actual}`
  )
}

export function assertMatch(source: string, pattern: RegExp, label: string): void {
  assert.ok(
    !pattern.flags.includes('m'),
    `${label}: line-anchored patterns must use assertRawMatch, not assertMatch`
  )
  assert.ok(
    pattern.test(collapseWhitespace(source)),
    `${label}: expected to match ${String(pattern)}`
  )
}

export function assertRawMatch(source: string, pattern: RegExp, label: string): void {
  assert.ok(pattern.test(source), `${label}: expected to match ${String(pattern)}`)
}

export function assertOrder(source: string, needles: (string | RegExp)[], label: string): void {
  const haystack = collapseWhitespace(source)
  const describe = (needle: string | RegExp): string =>
    typeof needle === 'string' ? JSON.stringify(needle) : String(needle)
  let previous = -1
  let previousLabel = 'the start of the file'
  for (const needle of needles) {
    // A wrapped member chain collapses to `a .b .c`, so a literal needle is layout-coupled.
    // Callers whose anchor can wrap pass a RegExp with \s* around the punctuation instead.
    const index =
      typeof needle === 'string'
        ? haystack.indexOf(collapseWhitespace(needle))
        : haystack.search(needle)
    assert.ok(index >= 0, `${label}: missing ${describe(needle)}`)
    assert.ok(index > previous, `${label}: ${describe(needle)} must appear after ${previousLabel}`)
    previous = index
    previousLabel = describe(needle)
  }
}
