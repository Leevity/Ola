import { afterEach, describe, expect, it } from 'vitest'
import cron from 'node-cron'
import type { CronJobEntry } from '../../src/renderer/src/stores/cron-store'
import {
  endOfLocalDay,
  listPlannedTimesForDay,
  startOfLocalDay
} from '../../src/renderer/src/components/tasks/task-schedule'

const previousTimeZone = process.env.TZ

afterEach(() => {
  if (previousTimeZone === undefined) delete process.env.TZ
  else process.env.TZ = previousTimeZone
})

function makeJob(schedule: CronJobEntry['schedule']): CronJobEntry {
  return {
    id: 'cron-test',
    schedule,
    deletedAt: null,
    enabled: true,
    lastFiredAt: null,
    updatedAt: 0,
    createdAt: 0
  } as CronJobEntry
}

describe('Cron calendar schedule projection', () => {
  it('uses a 23-hour local day at the spring daylight-saving transition', () => {
    process.env.TZ = 'America/New_York'
    const day = new Date(2026, 2, 8)
    const start = startOfLocalDay(day)
    const end = endOfLocalDay(day)

    expect(end.getTime() - start.getTime() + 1).toBe(23 * 60 * 60 * 1000)
  })

  it('projects cron times in the configured time zone, including a missing DST hour', () => {
    const start = Date.parse('2026-03-08T05:00:00.000Z')
    const end = Date.parse('2026-03-09T03:59:59.999Z')
    const existingHour = makeJob({ kind: 'cron', expr: '30 1 * * *', tz: 'America/New_York' })
    const missingHour = makeJob({ kind: 'cron', expr: '30 2 * * *', tz: 'America/New_York' })

    expect(listPlannedTimesForDay(existingHour, start, end)).toEqual([
      Date.parse('2026-03-08T06:30:00.000Z')
    ])
    expect(listPlannedTimesForDay(missingHour, start, end)).toEqual([])
  })

  it('projects interval schedules on their actual cadence rather than every calendar day', () => {
    const dayStart = Date.parse('2026-01-01T00:00:00.000Z')
    const dayEnd = Date.parse('2026-01-01T23:59:59.999Z')
    const everyTwoDays = makeJob({ kind: 'every', every: 2 * 24 * 60 * 60 * 1000 })
    everyTwoDays.updatedAt = dayStart

    expect(listPlannedTimesForDay(everyTwoDays, dayStart, dayEnd)).toEqual([])
    expect(
      listPlannedTimesForDay(
        everyTwoDays,
        dayStart + 24 * 60 * 60 * 1000,
        dayEnd + 24 * 60 * 60 * 1000
      )
    ).toEqual([])
    expect(
      listPlannedTimesForDay(
        everyTwoDays,
        dayStart + 2 * 24 * 60 * 60 * 1000,
        dayEnd + 2 * 24 * 60 * 60 * 1000
      )
    ).toEqual([dayStart + 2 * 24 * 60 * 60 * 1000])
  })

  it.each([
    ['0 9 * JAN MON', '2026-01-05T09:00:00.000Z'],
    ['0 9 * JAN-MAR MON-FRI', '2026-01-05T09:00:00.000Z'],
    ['0 22-2 * * *', '2026-10-01T00:00:00.000Z'],
    ['0 9 * * FRI-MON', '2026-10-09T09:00:00.000Z'],
    ['0 9 * */2 *', '2026-11-01T09:00:00.000Z'],
    ['0 9 */2 * *', '2026-10-01T09:00:00.000Z'],
    ['0 9 * * 5-1', '2026-10-11T09:00:00.000Z'],
    ['0 9 * * 7', '2026-01-04T09:00:00.000Z'],
    ['0 9 L FEB *', '2026-02-28T09:00:00.000Z'],
    ['0 9 L-2 FEB *', '2026-02-26T09:00:00.000Z'],
    ['0 9 LW FEB *', '2026-02-27T09:00:00.000Z'],
    ['0 9 1W AUG *', '2026-08-03T09:00:00.000Z'],
    ['0 9 * * 5#2', '2026-10-09T09:00:00.000Z'],
    ['0 9 * * 5L', '2026-10-30T09:00:00.000Z'],
    ['0 9 * * MONL', '2026-10-26T09:00:00.000Z'],
    ['@daily', '2026-10-01T00:00:00.000Z']
  ])('matches the production cron engine for %s', async (expression, expectedAt) => {
    const task = cron.createTask(expression, () => {}, { timezone: 'UTC' })
    const timestamp = Date.parse(expectedAt)
    const date = new Date(timestamp)
    const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    try {
      expect(task.match(date)).toBe(true)
      expect(
        listPlannedTimesForDay(
          makeJob({ kind: 'cron', expr: expression, tz: 'UTC' }),
          dayStart,
          dayStart + 86_400_000 - 1,
          1
        )
      ).toEqual([timestamp])
    } finally {
      await task.destroy()
    }
  })

  it.each([
    ['0 9 * JAN MON', '2026-01-06T09:00:00.000Z'],
    ['0 9 * */2 *', '2026-10-01T09:00:00.000Z'],
    ['0 9 */2 * *', '2026-10-02T09:00:00.000Z'],
    ['0 9 * * 7', '2026-01-05T09:00:00.000Z'],
    ['0 9 L FEB *', '2026-02-27T09:00:00.000Z'],
    ['0 9 1W AUG *', '2026-08-01T09:00:00.000Z'],
    ['0 9 * * 5#2', '2026-10-08T09:00:00.000Z'],
    ['0 9 * * 5L', '2026-10-23T09:00:00.000Z'],
    ['0 9 * * MONL', '2026-10-19T09:00:00.000Z']
  ])('does not show %s on a date the production scheduler skips', async (expression, at) => {
    const task = cron.createTask(expression, () => {}, { timezone: 'UTC' })
    const timestamp = Date.parse(at)
    const date = new Date(timestamp)
    const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    try {
      expect(task.match(date)).toBe(false)
      expect(
        listPlannedTimesForDay(
          makeJob({ kind: 'cron', expr: expression, tz: 'UTC' }),
          dayStart,
          dayStart + 86_400_000 - 1,
          1
        )
      ).toEqual([])
    } finally {
      await task.destroy()
    }
  })
})
