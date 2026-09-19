import { readFile, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { globLocalFiles } from './local-file-service'

export type LocalGrepMatch = {
  path: string
  line?: number
  column?: number
  text?: string
  kind?: 'match' | 'context'
  count?: number
}

export type LocalGrepResult = {
  kind: 'grep'
  matches: LocalGrepMatch[]
  meta: {
    backend: 'local'
    engine: 'node'
    searchRoot: string
    pathStyle: 'absolute' | 'relative_to_search_root'
    truncated: boolean
    timedOut: boolean
    limitReason: 'max_results' | 'max_output_bytes' | 'timeout' | null
    pattern: string
    include: string | null
    exclude: string | null
    outputMode: 'matches' | 'files_with_matches' | 'files_without_matches' | 'count'
    hiddenIncluded: boolean
    ignoredDefaultsApplied: true
    respectGitignore: boolean
    followSymlinks: boolean
    searchTime: number
    warnings: string[]
    maxDepth: number | null
    beforeContext: number
    afterContext: number
    maxResults: number
    maxOutputBytes: number
    maxLineLength: number
  }
  output: string
  error?: string
}

export type LocalGrepInput = Record<string, unknown> & { pattern?: string; path?: string }

type GrepOptions = {
  searchTarget: string
  pattern: string
  patterns: string[]
  notPatterns: string[]
  patternOperator: 'and' | 'or'
  allMatch: boolean
  include: string | null
  exclude: string | null
  includes: string[]
  excludes: string[]
  caseSensitive: boolean
  literal: boolean
  word: boolean
  line: boolean
  invertMatch: boolean
  onlyMatching: boolean
  column: boolean
  beforeContext: number
  afterContext: number
  maxResults: number
  maxOutputBytes: number
  maxLineLength: number
  maxScanLineLength: number
  maxCount: number | null
  maxDepth: number | null
  hidden: boolean
  respectGitignore: boolean
  followSymlinks: boolean
  outputMode: LocalGrepResult['meta']['outputMode']
  pathStyle: LocalGrepResult['meta']['pathStyle']
  timeoutMs: number
}

const DEFAULT_MAX_RESULTS = 100
const MAX_RESULTS = 200
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_MAX_LINE_LENGTH = 160
const MAX_LINE_LENGTH = 1000
const DEFAULT_MAX_SCAN_LINE_LENGTH = 16 * 1024
const MAX_SCAN_LINE_LENGTH = 64 * 1024
const MAX_CONTEXT_LINES = 20
const MAX_DEPTH = 50
const MAX_FILE_BYTES = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000

function finiteInt(value: unknown, fallback: number, max: number, min = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function optionalInt(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.min(max, Math.floor(value))
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim())
}

function patterns(value: unknown): string[] {
  return strings(value)
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter(Boolean)
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function globExpression(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '@@OLA_GLOBSTAR_SLASH@@')
    .replace(/\*\*/g, '@@OLA_GLOBSTAR@@')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replaceAll('@@OLA_GLOBSTAR_SLASH@@', '(?:.*/)?')
    .replaceAll('@@OLA_GLOBSTAR@@', '.*')
  return new RegExp(`^${escaped}$`)
}

function pathMatches(patterns: string[], candidate: string): boolean {
  if (patterns.length === 0) return true
  const normalized = candidate.replace(/\\/g, '/')
  const basename = normalized.split('/').at(-1) ?? normalized
  return patterns.some((pattern) => {
    const expression = globExpression(pattern)
    return expression.test(normalized) || expression.test(basename)
  })
}

function buildRegex(pattern: string, options: GrepOptions, global = false): RegExp {
  const source = options.literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern
  const wrapped = `${options.line ? '^(?:' : ''}${options.word ? '\\b(?:' : ''}${source}${options.word ? ')\\b' : ''}${options.line ? ')$' : ''}`
  return new RegExp(wrapped, `${options.caseSensitive ? '' : 'i'}${global ? 'g' : ''}`)
}

function normalizeInput(input: LocalGrepInput): GrepOptions {
  const pattern = typeof input.pattern === 'string' ? input.pattern : ''
  const normalizedPatterns = patterns(input.patterns)
  const selectedPatterns = normalizedPatterns.length ? normalizedPatterns : [pattern]
  if (!selectedPatterns.some(Boolean)) throw new Error('Missing grep pattern')
  const smartCase = bool(input.smartCase, false)
  const explicitCase = typeof input.caseSensitive === 'boolean' ? input.caseSensitive : undefined
  const ignoreCase = typeof input.ignoreCase === 'boolean' ? input.ignoreCase : undefined
  const context = finiteInt(input.context, 0, MAX_CONTEXT_LINES, 0)
  const requestedMode = input.outputMode ?? input.output_mode
  const outputMode = bool(input.filesWithMatches, false)
    ? 'files_with_matches'
    : bool(input.filesWithoutMatches, false)
      ? 'files_without_matches'
      : bool(input.count, false)
        ? 'count'
        : requestedMode === 'files_with_matches' ||
            requestedMode === 'files_without_matches' ||
            requestedMode === 'count'
          ? requestedMode
          : 'matches'
  const include =
    typeof input.include === 'string' && input.include.trim() ? input.include.trim() : null
  const exclude =
    typeof input.exclude === 'string' && input.exclude.trim() ? input.exclude.trim() : null
  return {
    searchTarget: resolve(
      typeof input.path === 'string' && input.path.trim() ? input.path : process.cwd()
    ),
    pattern,
    patterns: selectedPatterns,
    notPatterns: patterns(input.notPatterns),
    patternOperator: input.patternOperator === 'and' || input.operator === 'and' ? 'and' : 'or',
    allMatch: bool(input.allMatch, false),
    include,
    exclude,
    includes: [
      ...patterns(include),
      ...patterns(input.glob),
      ...patterns(input.includes),
      ...patterns(input.pathspecInclude)
    ],
    excludes: [
      ...patterns(exclude),
      ...patterns(input.excludes),
      ...patterns(input.pathspecExclude)
    ],
    caseSensitive:
      explicitCase ??
      (ignoreCase === undefined
        ? smartCase
          ? selectedPatterns.some((value) => /[A-Z]/.test(value))
          : true
        : !ignoreCase),
    literal:
      bool(input.literal, false) ||
      bool(input.fixed, false) ||
      bool(input.fixedStrings, false) ||
      input.patternMode === 'fixed',
    word: bool(input.word, false),
    line: bool(input.line, false),
    invertMatch: bool(input.invertMatch, false),
    onlyMatching: bool(input.onlyMatching, false),
    column: bool(input.column, false),
    beforeContext:
      input.beforeContext === undefined
        ? context
        : finiteInt(input.beforeContext, 0, MAX_CONTEXT_LINES, 0),
    afterContext:
      input.afterContext === undefined
        ? context
        : finiteInt(input.afterContext, 0, MAX_CONTEXT_LINES, 0),
    maxResults: finiteInt(
      input.maxResults ?? input.head_limit ?? input.headLimit ?? input.limit,
      DEFAULT_MAX_RESULTS,
      MAX_RESULTS
    ),
    maxOutputBytes: finiteInt(input.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES),
    maxLineLength: finiteInt(input.maxLineLength, DEFAULT_MAX_LINE_LENGTH, MAX_LINE_LENGTH),
    maxScanLineLength: finiteInt(
      input.maxScanLineLength,
      DEFAULT_MAX_SCAN_LINE_LENGTH,
      MAX_SCAN_LINE_LENGTH
    ),
    maxCount: optionalInt(input.maxCount, MAX_RESULTS),
    maxDepth: optionalInt(input.maxDepth, MAX_DEPTH),
    hidden: bool(input.hidden, true),
    respectGitignore: bool(input.respectGitignore, true),
    followSymlinks: bool(input.followSymlinks, false),
    outputMode,
    pathStyle: input.pathStyle === 'absolute' ? 'absolute' : 'relative_to_search_root',
    timeoutMs: finiteInt(input.timeoutMs, DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  }
}

function trimLine(value: string, max: number): string {
  const normalized = value.trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 3))}...`
}

function outputFor(matches: LocalGrepMatch[], options: GrepOptions): string {
  return matches
    .map((item) => {
      if (
        options.outputMode === 'files_with_matches' ||
        options.outputMode === 'files_without_matches'
      )
        return item.path
      if (options.outputMode === 'count') return `${item.path}:${item.count ?? 0}`
      if (item.line === undefined) return item.path
      const separator = item.kind === 'context' ? '-' : ':'
      const column =
        options.column && item.column !== undefined && item.kind !== 'context'
          ? `${item.column}:`
          : ''
      return `${item.path}${separator}${item.line}${separator}${column}${item.text ?? ''}`
    })
    .join('\n')
}

export async function grepLocalFiles(input: LocalGrepInput): Promise<LocalGrepResult> {
  const startedAt = Date.now()
  let options: GrepOptions
  try {
    options = normalizeInput(input)
  } catch (error) {
    const searchRoot = resolve(
      typeof input.path === 'string' && input.path ? input.path : process.cwd()
    )
    return errorResult(
      searchRoot,
      typeof input.pattern === 'string' ? input.pattern : '',
      String(error)
    )
  }
  const meta = (overrides: Partial<LocalGrepResult['meta']> = {}): LocalGrepResult['meta'] => ({
    backend: 'local',
    engine: 'node',
    searchRoot: options.searchTarget,
    pathStyle: options.pathStyle,
    truncated: false,
    timedOut: false,
    limitReason: null,
    pattern: options.pattern,
    include: options.include,
    exclude: options.exclude,
    outputMode: options.outputMode,
    hiddenIncluded: options.hidden,
    ignoredDefaultsApplied: true,
    respectGitignore: options.respectGitignore,
    followSymlinks: options.followSymlinks,
    searchTime: Date.now() - startedAt,
    warnings: [],
    maxDepth: options.maxDepth,
    beforeContext: options.beforeContext,
    afterContext: options.afterContext,
    maxResults: options.maxResults,
    maxOutputBytes: options.maxOutputBytes,
    maxLineLength: options.maxLineLength,
    ...overrides
  })
  try {
    const searchStats = await stat(options.searchTarget)
    const root = searchStats.isDirectory()
      ? options.searchTarget
      : resolve(options.searchTarget, '..')
    const listing = await globLocalFiles({
      path: options.searchTarget,
      pattern: searchStats.isDirectory() ? '**/*' : '*',
      limit: 10_000,
      hidden: options.hidden,
      respectGitignore: options.respectGitignore,
      maxDepth: options.maxDepth ?? 50
    })
    const positive = options.patterns.map((pattern) => buildRegex(pattern, options))
    const negative = options.notPatterns.map((pattern) => buildRegex(pattern, options))
    const matches: LocalGrepMatch[] = []
    let byteCount = 2
    let limitReason: LocalGrepResult['meta']['limitReason'] = null
    let timedOut = false
    const add = (match: LocalGrepMatch): boolean => {
      if (matches.length >= options.maxResults) {
        limitReason ??= 'max_results'
        return false
      }
      const candidateBytes =
        Buffer.byteLength(match.path) + Buffer.byteLength(match.text ?? '') + 96
      if (byteCount + candidateBytes > options.maxOutputBytes) {
        limitReason ??= 'max_output_bytes'
        return false
      }
      matches.push(match)
      byteCount += candidateBytes
      return true
    }
    for (const entry of listing.matches) {
      if (Date.now() - startedAt > options.timeoutMs) {
        timedOut = true
        limitReason = 'timeout'
        break
      }
      if (entry.type !== 'file') continue
      const displayRelative = relative(root, entry.path).replace(/\\/g, '/')
      if (
        !pathMatches(options.includes, displayRelative) ||
        (options.excludes.length && pathMatches(options.excludes, displayRelative))
      )
        continue
      const info = await stat(entry.path).catch(() => null)
      if (!info || info.size === 0 || info.size > MAX_FILE_BYTES) continue
      const data = await readFile(entry.path).catch(() => null)
      if (!data || data.includes(0)) continue
      const lines = data.toString('utf8').replace(/\r\n?/g, '\n').split('\n')
      const fileMatches: LocalGrepMatch[] = []
      const positiveHits = new Array(positive.length).fill(false)
      let hasMatch = false
      let matchedCount = 0
      let emitted = 0
      let after = 0
      for (let index = 0; index < lines.length; index += 1) {
        const raw = lines[index]
        const line =
          raw.length > options.maxScanLineLength ? raw.slice(0, options.maxScanLineLength) : raw
        const hits = positive.map((regex) => {
          regex.lastIndex = 0
          return regex.test(line)
        })
        hits.forEach((hit, hitIndex) => {
          positiveHits[hitIndex] ||= hit
        })
        const positiveMatch =
          options.patternOperator === 'and' ? hits.every(Boolean) : hits.some(Boolean)
        const hasNegative = negative.some((regex) => {
          regex.lastIndex = 0
          return regex.test(line)
        })
        const matched = options.invertMatch
          ? !positiveMatch || hasNegative
          : positiveMatch && !hasNegative
        const displayPath = options.pathStyle === 'absolute' ? entry.path : displayRelative
        if (matched) {
          hasMatch = true
          if (options.maxCount === null || matchedCount < options.maxCount) matchedCount += 1
          if (
            options.outputMode === 'matches' &&
            (options.maxCount === null || emitted < options.maxCount)
          ) {
            if (!options.onlyMatching && options.beforeContext) {
              for (
                let before = Math.max(0, index - options.beforeContext);
                before < index;
                before += 1
              ) {
                if (!fileMatches.some((item) => item.line === before + 1))
                  fileMatches.push({
                    path: displayPath,
                    line: before + 1,
                    text: trimLine(lines[before], options.maxLineLength),
                    kind: 'context'
                  })
              }
            }
            if (options.onlyMatching) {
              const parts = positive.flatMap((regex) =>
                Array.from(
                  line.matchAll(
                    buildRegex(
                      regex.source,
                      { ...options, literal: false, word: false, line: false },
                      true
                    )
                  )
                )
              )
              for (const part of parts) {
                if (options.maxCount !== null && emitted >= options.maxCount) break
                if (!part[0]) continue
                fileMatches.push({
                  path: displayPath,
                  line: index + 1,
                  column: options.column ? (part.index ?? 0) + 1 : undefined,
                  text: trimLine(part[0], options.maxLineLength),
                  kind: 'match'
                })
                emitted += 1
              }
            } else {
              const first = positive.find((regex) => {
                regex.lastIndex = 0
                return regex.test(line)
              })
              const firstMatch = first?.exec(line)
              fileMatches.push({
                path: displayPath,
                line: index + 1,
                column: options.column && firstMatch ? firstMatch.index + 1 : undefined,
                text: trimLine(line, options.maxLineLength),
                kind: 'match'
              })
              emitted += 1
              after = options.afterContext
            }
          }
        } else if (after > 0 && options.outputMode === 'matches') {
          const displayPath = options.pathStyle === 'absolute' ? entry.path : displayRelative
          if (!fileMatches.some((item) => item.line === index + 1))
            fileMatches.push({
              path: displayPath,
              line: index + 1,
              text: trimLine(line, options.maxLineLength),
              kind: 'context'
            })
          after -= 1
        }
      }
      const allPatternsSeen = !options.allMatch || positiveHits.every(Boolean)
      if (allPatternsSeen) {
        const displayPath = options.pathStyle === 'absolute' ? entry.path : displayRelative
        if (options.outputMode === 'files_with_matches' && hasMatch)
          fileMatches.splice(0, fileMatches.length, { path: displayPath })
        if (options.outputMode === 'files_without_matches' && !hasMatch)
          fileMatches.splice(0, fileMatches.length, { path: displayPath })
        if (options.outputMode === 'count' && hasMatch)
          fileMatches.splice(0, fileMatches.length, { path: displayPath, count: matchedCount })
        for (const match of fileMatches) if (!add(match)) break
      }
      if (limitReason) break
    }
    const output = outputFor(matches, options)
    return {
      kind: 'grep',
      matches,
      meta: meta({ truncated: Boolean(limitReason), timedOut, limitReason }),
      output
    }
  } catch (error) {
    return {
      kind: 'grep',
      matches: [],
      meta: meta(),
      output: '',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function errorResult(searchRoot: string, pattern: string, error: string): LocalGrepResult {
  return {
    kind: 'grep',
    matches: [],
    output: '',
    error,
    meta: {
      backend: 'local',
      engine: 'node',
      searchRoot,
      pathStyle: 'relative_to_search_root',
      truncated: false,
      timedOut: false,
      limitReason: null,
      pattern,
      include: null,
      exclude: null,
      outputMode: 'matches',
      hiddenIncluded: true,
      ignoredDefaultsApplied: true,
      respectGitignore: true,
      followSymlinks: false,
      searchTime: 0,
      warnings: [],
      maxDepth: null,
      beforeContext: 0,
      afterContext: 0,
      maxResults: DEFAULT_MAX_RESULTS,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      maxLineLength: DEFAULT_MAX_LINE_LENGTH
    }
  }
}

/**
 * The TS engine may only become the desktop default for requests whose semantics
 * it can preserve. Callers must keep the Native implementation for unsupported
 * Git index/textconv, multiline, basic-regexp and pathspec variants during the
 * staged cutover.
 */
export function canUseTsLocalGrep(input: LocalGrepInput): boolean {
  if (input.patternMode === 'basic' || input.multiline === true) return false
  return (
    ![
      'textconv',
      'cached',
      'index',
      'noIndex',
      'untracked',
      'pathspec',
      'pathspecs',
      'pathspecInclude',
      'pathspecIncludes',
      'pathspecExclude',
      'pathspecExcludes',
      'type'
    ].some((key) => input[key] !== undefined && input[key] !== false && input[key] !== '') &&
    input.text !== true &&
    input.followSymlinks !== true
  )
}
