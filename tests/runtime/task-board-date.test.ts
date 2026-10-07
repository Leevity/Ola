import { describe, expect, it } from 'vitest'
import { fromTaskDateInput, toTaskDateInput } from '../../src/renderer/src/lib/task-calendar-date'

describe('task board calendar dates', () => {
  it('round trips a local calendar day without UTC conversion', () => {
    const value = fromTaskDateInput('2026-10-01')
    expect(value).toBeDefined()
    expect(toTaskDateInput(value)).toBe('2026-10-01')
  })

  it('rejects impossible dates and empty input', () => {
    expect(fromTaskDateInput('2026-02-30')).toBeUndefined()
    expect(fromTaskDateInput('')).toBeUndefined()
    expect(toTaskDateInput(undefined)).toBe('')
  })

  it('handles four-digit years below 100 without JavaScript date remapping', () => {
    const value = fromTaskDateInput('0099-01-01')
    expect(value).toBeDefined()
    expect(toTaskDateInput(value)).toBe('0099-01-01')
  })

  it('projects the same stored calendar day in different time zones and across DST', () => {
    const previousZone = process.env.TZ
    try {
      process.env.TZ = 'America/Los_Angeles'
      const pacific = fromTaskDateInput('2026-03-08')
      expect(toTaskDateInput(pacific)).toBe('2026-03-08')
      process.env.TZ = 'Asia/Shanghai'
      const shanghai = fromTaskDateInput('2026-03-08')
      expect(toTaskDateInput(shanghai)).toBe('2026-03-08')
      expect(pacific).not.toBe(shanghai)
    } finally {
      if (previousZone === undefined) delete process.env.TZ
      else process.env.TZ = previousZone
    }
  })
})
