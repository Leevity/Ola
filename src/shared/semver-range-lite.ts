// ── Minimal semver-range matching for pre-spawn runtime gates ──
//
// The repository has no `semver` dependency and this runs in Main before a child process is
// spawned, so the matcher stays dependency-free. It covers the operators an engines field actually
// uses: `||` alternation, `^MAJOR.MINOR.PATCH`, `>=`, `>`, `<`, `<=`, `=`, and space-separated
// conjunctions. Anything it cannot parse reports `unknown`, and callers must fail open — a server
// must never be stranded by our inability to read an exotic `--version` string.

export type RangeMatch = 'satisfied' | 'unsatisfied' | 'unknown'

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string
}

const VERSION_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:\d+|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:\d+|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+)?$/

/** Parse a semver string, or `null` when it is not a strict `MAJOR.MINOR.PATCH`. */
export function parseVersion(raw: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(raw.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? ''
  }
}

function compare(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  // A prerelease sorts below its release, and different prereleases are never treated as equal
  // to the plain version so `>=1.2.3` cannot be satisfied by `1.2.3-alpha`.
  if (!left.prerelease && !right.prerelease) return 0
  if (!left.prerelease) return 1
  if (!right.prerelease) return -1
  return left.prerelease < right.prerelease ? -1 : left.prerelease > right.prerelease ? 1 : 0
}

function matchesComparator(version: ParsedVersion, comparator: string): RangeMatch {
  const token = comparator.trim()
  if (!token) return 'unknown'
  if (token === '*' || token === 'x' || token === 'X') return 'satisfied'

  const caret = /^\^\d+\.\d+\.\d+$/.test(token)
  const operatorMatch = /^([<>]=?|=)?\s*(\d+(?:\.\d+){0,2})$/.exec(token)
  if (!caret && !operatorMatch) return 'unknown'

  if (caret) {
    const bound = parseVersion(token.slice(1))
    if (!bound) return 'unknown'
    if (version.prerelease && compare(version, bound) < 0) return 'unsatisfied'
    // `^1.2.3` = `>=1.2.3 <2.0.0`, but a zero major pins the next significant digit:
    // `^0.2.3` = `>=0.2.3 <0.3.0` and `^0.0.3` = `>=0.0.3 <0.1.0`.
    if (bound.major > 0)
      return version.major === bound.major && compare(version, bound) >= 0
        ? 'satisfied'
        : 'unsatisfied'
    if (bound.minor > 0)
      return version.major === 0 && version.minor === bound.minor && version.patch >= bound.patch
        ? 'satisfied'
        : 'unsatisfied'
    return version.major === 0 && version.minor === 0 && version.patch >= bound.patch
      ? 'satisfied'
      : 'unsatisfied'
  }

  const [, operator, rawBound] = operatorMatch as unknown as [string, string | undefined, string]
  // `20`, `20.1` and `20.1.2` are all legal bounds; `parseVersion` only accepts the full form.
  const parts = rawBound.split('.')
  const bound = parseVersion(`${parts[0]}.${parts[1] ?? 0}.${parts[2] ?? 0}`)
  if (!bound) return 'unknown'
  const ordering = compare(version, bound)
  const minorBound = /^\d+\.\d+$/.test(rawBound)
  const majorOnlyBound = /^\d+$/.test(rawBound)
  switch (operator) {
    case '>':
      return ordering > 0 ? 'satisfied' : 'unsatisfied'
    case '>=':
      return ordering >= 0 ? 'satisfied' : 'unsatisfied'
    case '<':
      // `node <25` on a `25.1.2` host means "below major 25", which the raw comparison cannot say.
      if (majorOnlyBound) return version.major < bound.major ? 'satisfied' : 'unsatisfied'
      if (minorBound)
        return version.major < bound.major ||
          (version.major === bound.major && version.minor < bound.minor)
          ? 'satisfied'
          : 'unsatisfied'
      return ordering < 0 ? 'satisfied' : 'unsatisfied'
    case '<=':
      if (majorOnlyBound) return version.major <= bound.major ? 'satisfied' : 'unsatisfied'
      if (minorBound)
        return version.major < bound.major ||
          (version.major === bound.major && version.minor <= bound.minor)
          ? 'satisfied'
          : 'unsatisfied'
      return ordering <= 0 ? 'satisfied' : 'unsatisfied'
    default:
      if (majorOnlyBound) return version.major === bound.major ? 'satisfied' : 'unsatisfied'
      if (minorBound)
        return version.major === bound.major && version.minor === bound.minor
          ? 'satisfied'
          : 'unsatisfied'
      return ordering === 0 ? 'satisfied' : 'unsatisfied'
  }
}

/**
 * Match a version against a range such as `^22.23.4 || ^24.22.1 || >=26.12.1`.
 * Returns `unknown` when either side is unreadable; callers fail open on `unknown`.
 */
export function matchesNodeRange(versionRaw: string, rangeRaw: string): RangeMatch {
  const version = parseVersion(versionRaw)
  if (!version) return 'unknown'
  const alternatives = rangeRaw.split('||')
  if (!alternatives.length) return 'unknown'

  let sawUnknown = false
  for (const alternative of alternatives) {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean)
    if (!comparators.length) {
      sawUnknown = true
      continue
    }
    let satisfied = true
    for (const comparator of comparators) {
      const result = matchesComparator(version, comparator)
      if (result === 'unknown') {
        sawUnknown = true
        satisfied = false
        break
      }
      if (result === 'unsatisfied') {
        satisfied = false
        break
      }
    }
    if (satisfied) return 'satisfied'
  }
  return sawUnknown ? 'unknown' : 'unsatisfied'
}
