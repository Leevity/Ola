import { describe, expect, it } from 'vitest'
import { isImeCommitKey } from '../../src/renderer/src/lib/keyboard-composition'

describe('IME keyboard guard', () => {
  it('ignores active composition and legacy IME key events', () => {
    expect(isImeCommitKey({ key: 'Enter', isComposing: true })).toBe(true)
    expect(isImeCommitKey({ key: 'Enter', nativeEvent: { isComposing: true } })).toBe(true)
    expect(isImeCommitKey({ key: 'Enter', nativeEvent: { keyCode: 229 } })).toBe(true)
    expect(isImeCommitKey({ key: 'Enter', keyCode: 229 })).toBe(true)
    expect(isImeCommitKey({ key: 'Enter' }, Number.POSITIVE_INFINITY)).toBe(true)
  })

  it('ignores the candidate-confirming Enter just after composition ends', () => {
    expect(isImeCommitKey({ key: 'Enter' }, 1_000, 1_050)).toBe(true)
    expect(isImeCommitKey({ key: 'Enter' }, 1_000, 1_100)).toBe(false)
    expect(isImeCommitKey({ key: 'Enter' }, 1_000, 1_250)).toBe(false)
    expect(isImeCommitKey({ key: 'a' }, 1_000, 1_050)).toBe(false)
    expect(isImeCommitKey({ key: 'Enter' }, 0, 50)).toBe(false)
  })
})
