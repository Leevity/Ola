import { describe, expect, it } from 'vitest'
import {
  classifyRemoteKey,
  normalizeVideoPoint,
  REMOTE_NAMED_KEYS
} from '../../src/renderer/src/hooks/use-remote-controller-input'
import { collapseWhitespace, readSource } from '../../tools/lib/source-text'

const geometry = (
  videoWidth: number,
  videoHeight: number,
  rect = { left: 0, top: 0, width: 1600, height: 900 }
) => ({ rect, videoWidth, videoHeight })

describe('normalizeVideoPoint', () => {
  it('maps the centre of a 21:9 picture inside a 16:9 element to the centre of the screen', () => {
    // object-contain fits by width here, leaving 112.5px bars top and bottom.
    const point = normalizeVideoPoint(geometry(2560, 1080), 800, 450, false)
    expect(point).toEqual({ x: 0.5, y: 0.5 })
  })

  it('drops a hover in the top bar instead of clamping it to the screen edge', () => {
    expect(normalizeVideoPoint(geometry(2560, 1080), 800, 50, false)).toBeNull()
    expect(normalizeVideoPoint(geometry(2560, 1080), 800, 880, false)).toBeNull()
  })

  it('clamps a drag that leaves the picture so the remote cursor sticks to the edge', () => {
    expect(normalizeVideoPoint(geometry(2560, 1080), 800, -200, true)).toEqual({ x: 0.5, y: 0 })
    expect(normalizeVideoPoint(geometry(2560, 1080), 4000, 2000, true)).toEqual({ x: 1, y: 1 })
  })

  it('maps the centre of a 16:10 picture inside a 16:9 element through the side bars', () => {
    // Fits by height: 1440px of picture centred in 1600px, so 80px bars left/right.
    const point = normalizeVideoPoint(geometry(1600, 1000), 800, 450, false)
    expect(point).toEqual({ x: 0.5, y: 0.5 })
    expect(normalizeVideoPoint(geometry(1600, 1000), 40, 450, false)).toBeNull()
    expect(normalizeVideoPoint(geometry(1600, 1000), 80, 450, false)).toEqual({ x: 0, y: 0.5 })
  })

  it('accounts for the element offset on the page', () => {
    const point = normalizeVideoPoint(
      geometry(2560, 1080, { left: 100, top: 50, width: 1600, height: 900 }),
      900,
      500,
      false
    )
    expect(point).toEqual({ x: 0.5, y: 0.5 })
  })

  it('has no bars when the picture already matches the element ratio', () => {
    const point = normalizeVideoPoint(geometry(1920, 1080), 0, 0, false)
    expect(point).toEqual({ x: 0, y: 0 })
    expect(normalizeVideoPoint(geometry(1920, 1080), 1600, 900, false)).toEqual({ x: 1, y: 1 })
  })

  it('refuses to map before the stream reports its dimensions', () => {
    expect(normalizeVideoPoint(geometry(0, 0), 800, 450, false)).toBeNull()
    expect(normalizeVideoPoint(geometry(0, 0), 800, 450, true)).toBeNull()
    expect(
      normalizeVideoPoint(
        geometry(1920, 1080, { left: 0, top: 0, width: 0, height: 0 }),
        0,
        0,
        true
      )
    ).toBeNull()
  })
})

describe('classifyRemoteKey', () => {
  it('sends letters and digits as key events so modifiers still apply', () => {
    for (const key of ['a', 'Z', '0', '9']) expect(classifyRemoteKey(key)).toBe('key')
  })

  it('sends punctuation and space as text because robotjs has no key name for them', () => {
    for (const key of ['-', '=', '[', ';', '/', ' ', 'é', '中']) {
      expect(classifyRemoteKey(key)).toBe('text')
    }
  })

  it('sends named keys and function keys as key events', () => {
    for (const key of ['Enter', 'ArrowLeft', 'Backspace', 'Meta', 'F1', 'F12']) {
      expect(classifyRemoteKey(key)).toBe('key')
    }
  })

  it('ignores keys the controlled machine cannot press', () => {
    for (const key of [
      'CapsLock',
      'NumLock',
      'Insert',
      'PrintScreen',
      'Dead',
      'Unidentified',
      'F13'
    ]) {
      expect(classifyRemoteKey(key)).toBeNull()
    }
  })
})

const mainKeySource = collapseWhitespace(await readSource('src/main/ipc/desktop-control.ts'))

describe('REMOTE_NAMED_KEYS', () => {
  // The renderer decides whether a keystroke is worth sending; Main decides
  // whether it can press it. If the two tables drift, a key silently stops
  // working, so bind them to the real source rather than to a second copy.
  const block = /const KEY_MAP: Record<string, string> = \{(.*?)\}/.exec(mainKeySource)

  it('finds the Main-side key table', () => {
    expect(block).not.toBeNull()
  })

  it('covers every key Main can resolve by name', () => {
    const mainKeys = [...block![1].matchAll(/([A-Za-z0-9]+):/g)].map((match) => match[1])
    expect(mainKeys.length).toBeGreaterThan(10)
    for (const key of mainKeys) expect(REMOTE_NAMED_KEYS.has(key)).toBe(true)
  })

  it('adds nothing Main cannot resolve outside the function-key range', () => {
    const mainKeys = new Set([...block![1].matchAll(/([A-Za-z0-9]+):/g)].map((match) => match[1]))
    for (const key of REMOTE_NAMED_KEYS) {
      if (/^F([1-9]|1[0-2])$/.test(key)) continue
      expect(mainKeys.has(key)).toBe(true)
    }
  })

  it('matches the function-key range Main accepts', () => {
    expect(mainKeySource).toContain('name.match(/^F([1-9]|1[0-2])$/)')
    for (let index = 1; index <= 12; index += 1) {
      expect(REMOTE_NAMED_KEYS.has(`F${index}`)).toBe(true)
    }
    expect(REMOTE_NAMED_KEYS.has('F13')).toBe(false)
  })
})
