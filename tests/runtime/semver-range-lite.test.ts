import { describe, expect, it } from 'vitest'
import { matchesNodeRange, parseVersion } from '../../src/shared/semver-range-lite'

// REA declares `^22.23.4 || ^24.22.1 || >=26.12.1`. The whole point of this matcher is that
// ordinary LTS releases fall outside it: a `23.x` or `25.x` host is unsatisfied, not unknown.
const REA_RANGE = '^22.23.4 || ^24.22.1 || >=26.12.1'

describe('semver range matcher', () => {
  it('parses strict versions and rejects anything looser', () => {
    expect(parseVersion('v24.22.1')).toMatchObject({ major: 24, minor: 22, patch: 1 })
    expect(parseVersion(' 22.23.4 ')).toMatchObject({ major: 22 })
    expect(parseVersion('24.22')).toBeNull()
    expect(parseVersion('nightly')).toBeNull()
    expect(parseVersion('')).toBeNull()
  })

  it('satisfies the declared alternatives and refuses the gaps between them', () => {
    expect(matchesNodeRange('v22.23.4', REA_RANGE)).toBe('satisfied')
    expect(matchesNodeRange('v22.30.0', REA_RANGE)).toBe('satisfied')
    expect(matchesNodeRange('v24.22.1', REA_RANGE)).toBe('satisfied')
    expect(matchesNodeRange('v26.12.1', REA_RANGE)).toBe('satisfied')
    expect(matchesNodeRange('v27.0.0', REA_RANGE)).toBe('satisfied')
    expect(matchesNodeRange('v22.23.3', REA_RANGE)).toBe('unsatisfied')
    expect(matchesNodeRange('v23.11.0', REA_RANGE)).toBe('unsatisfied')
    // The real host this integration was developed on.
    expect(matchesNodeRange('v25.6.1', REA_RANGE)).toBe('unsatisfied')
  })

  it('keeps prereleases below their release', () => {
    expect(matchesNodeRange('24.22.1-rc.1', REA_RANGE)).toBe('unsatisfied')
    expect(matchesNodeRange('26.13.0-rc.1', REA_RANGE)).toBe('satisfied')
  })

  it('handles the operators a engines field actually uses', () => {
    expect(matchesNodeRange('18.0.0', '>=16 <19')).toBe('satisfied')
    expect(matchesNodeRange('19.0.0', '>=16 <19')).toBe('unsatisfied')
    expect(matchesNodeRange('19.0.1', '<20')).toBe('satisfied')
    expect(matchesNodeRange('20.1.2', '<20')).toBe('unsatisfied')
    expect(matchesNodeRange('20.1.2', '<=20.1')).toBe('satisfied')
    expect(matchesNodeRange('20.2.0', '<=20.1')).toBe('unsatisfied')
    expect(matchesNodeRange('14.0.0', '14 || 16')).toBe('satisfied')
    expect(matchesNodeRange('15.0.0', '14 || 16')).toBe('unsatisfied')
    expect(matchesNodeRange('99.0.0', '*')).toBe('satisfied')
  })

  it('reports unknown rather than guessing, so callers can fail open', () => {
    expect(matchesNodeRange('not-a-version', REA_RANGE)).toBe('unknown')
    expect(matchesNodeRange('24.22.1', '~> 24')).toBe('unknown')
    expect(matchesNodeRange('24.22.1', '')).toBe('unknown')
  })

  it('bounds the caret behavior at major zero the way npm does', () => {
    expect(matchesNodeRange('0.3.9', '^0.2.0')).toBe('unsatisfied')
    expect(matchesNodeRange('0.2.9', '^0.2.0')).toBe('satisfied')
    expect(matchesNodeRange('0.0.5', '^0.0.3')).toBe('satisfied')
    expect(matchesNodeRange('0.0.2', '^0.0.3')).toBe('unsatisfied')
  })
})
