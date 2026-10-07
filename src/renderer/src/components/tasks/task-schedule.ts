import type { TFunction } from 'i18next'
import type { CronJobEntry, CronSchedule } from '@renderer/stores/cron-store'
import { resolveIntlLocale } from '@renderer/lib/i18n-language'

export interface DayWindowEntry {
  key: string
  date: Date
  start: number
  end: number
  isToday: boolean
}

const MINUTE_MS = 60_000
const PLANNED_TIME_LIMIT = 500

function resolveTaskLocale(language?: string): string {
  return resolveIntlLocale(language)
}

export function startOfLocalDay(value: Date | number): Date {
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)
}

export function endOfLocalDay(value: Date | number): Date {
  const start = startOfLocalDay(value)
  const nextDay = new Date(start)
  nextDay.setDate(nextDay.getDate() + 1)
  return new Date(nextDay.getTime() - 1)
}

export function dateKeyFromDate(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function dateKeyFromTimestamp(timestamp: number): string {
  return dateKeyFromDate(new Date(timestamp))
}

export function buildDayWindow(pastDays = 7, futureDays = 30): DayWindowEntry[] {
  const today = startOfLocalDay(Date.now())
  const entries: DayWindowEntry[] = []
  for (let offset = -pastDays; offset <= futureDays; offset++) {
    const date = new Date(today)
    date.setDate(today.getDate() + offset)
    const start = startOfLocalDay(date).getTime()
    const end = endOfLocalDay(date).getTime()
    entries.push({
      key: dateKeyFromDate(date),
      date,
      start,
      end,
      isToday: offset === 0
    })
  }
  return entries
}

export function formatDayLabel(date: Date, t: TFunction, language?: string): string {
  const locale = resolveTaskLocale(language)
  const todayKey = dateKeyFromTimestamp(Date.now())
  const key = dateKeyFromDate(date)
  if (key === todayKey) return t('tasksPage.dayToday')
  const tomorrow = new Date(startOfLocalDay(Date.now()))
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (key === dateKeyFromDate(tomorrow)) return t('tasksPage.dayTomorrow')
  const yesterday = new Date(startOfLocalDay(Date.now()))
  yesterday.setDate(yesterday.getDate() - 1)
  if (key === dateKeyFromDate(yesterday)) return t('tasksPage.dayYesterday')
  return date.toLocaleDateString(locale, { month: 'numeric', day: 'numeric', weekday: 'short' })
}

export function formatTimeLabel(timestamp: number | null | undefined, language?: string): string {
  if (!timestamp) return '—'
  return new Date(timestamp).toLocaleTimeString(resolveTaskLocale(language), {
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function formatDateTimeLabel(
  timestamp: number | null | undefined,
  language?: string
): string {
  if (!timestamp) return '—'
  return new Date(timestamp).toLocaleString(resolveTaskLocale(language), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function formatIntervalLabel(ms: number | null | undefined, t: TFunction): string {
  if (!ms) return '—'
  if (ms < 60_000) {
    return t('tasksPage.intervalSeconds', {
      value: Math.round(ms / 1000)
    })
  }
  if (ms < 3_600_000) {
    return t('tasksPage.intervalMinutes', {
      value: Math.round(ms / 60_000)
    })
  }
  if (ms < 86_400_000) {
    return t('tasksPage.intervalHours', {
      value: (ms / 3_600_000).toFixed(ms % 3_600_000 === 0 ? 0 : 1)
    })
  }
  return t('tasksPage.intervalDays', {
    value: (ms / 86_400_000).toFixed(ms % 86_400_000 === 0 ? 0 : 1)
  })
}

export function scheduleKindLabel(kind: CronSchedule['kind'], t: TFunction): string {
  switch (kind) {
    case 'at':
      return t('tasksPage.scheduleKindAt')
    case 'every':
      return t('tasksPage.scheduleKindEvery')
    case 'cron':
      return t('tasksPage.scheduleKindCron')
  }
}

export function scheduleSummary(job: CronJobEntry, t: TFunction, language?: string): string {
  if (job.schedule.kind === 'at') return formatDateTimeLabel(job.schedule.at, language)
  if (job.schedule.kind === 'every') return formatIntervalLabel(job.schedule.every, t)
  return job.schedule.expr ?? '—'
}

function normalizeCronToken(token: string): string {
  return token.trim() === '?' ? '*' : token.trim()
}

function matchesCronField(field: string, value: number, min: number, max: number): boolean {
  const normalized = normalizeCronToken(field)
  if (normalized === '*') return true

  for (const part of normalized.split(',')) {
    const segment = part.trim()
    if (!segment) continue

    const stepMatch = segment.match(/^(.+)\/(\d+)$/)
    const step = stepMatch ? Number.parseInt(stepMatch[2], 10) : 0
    const base = stepMatch ? stepMatch[1] : segment

    if (base === '*') {
      if (!step) return true
      if ((value - min) % step === 0) return true
      continue
    }

    const rangeMatch = base.match(/^(\d+)-(\d+)$/)
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10)
      const end = Number.parseInt(rangeMatch[2], 10)
      const size = max - min + 1
      const span = start <= end ? end - start : (((end - start) % size) + size) % size
      const offset = start <= end ? value - start : (((value - start) % size) + size) % size
      if (offset >= 0 && offset <= span && (!step || offset % step === 0)) return true
      continue
    }

    if (/^\d+$/.test(base) && Number.parseInt(base, 10) === value) return true
  }

  return false
}

function expandCronFieldValues(field: string, min: number, max: number): number[] {
  const values: number[] = []
  for (let value = min; value <= max; value++) {
    if (matchesCronField(field, value, min, max)) {
      values.push(value)
    }
  }
  return values
}

function getWeekdayIndex(label: string): number {
  const lower = label.toLowerCase()
  const map: Record<string, number> = {
    sun: 0,
    sunday: 0,
    mon: 1,
    monday: 1,
    tue: 2,
    tuesday: 2,
    wed: 3,
    wednesday: 3,
    thu: 4,
    thursday: 4,
    fri: 5,
    friday: 5,
    sat: 6,
    saturday: 6
  }
  return map[lower] ?? 0
}

const CRON_NICKNAMES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *'
}

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december'
]
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

function normalizeNamedCronField(field: string, names: readonly string[], first: number): string {
  return field.replace(/[a-z]+/gi, (token) => {
    const name = token.toLowerCase()
    const index = names.findIndex((item) => item === name || item.slice(0, 3) === name)
    if (index >= 0) return String(index + first)
    if (name.endsWith('l')) {
      const stem = name.slice(0, -1)
      const lastIndex = names.findIndex((item) => item === stem || item.slice(0, 3) === stem)
      if (lastIndex >= 0) return `${lastIndex + first}L`
    }
    return token
  })
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function nearestWeekday(year: number, month: number, target: number): number {
  const last = lastDayOfMonth(year, month)
  if (target < 1 || target > last) return -1
  const weekday = new Date(Date.UTC(year, month - 1, target)).getUTCDay()
  if (weekday === 6) return target === 1 ? target + 2 : target - 1
  if (weekday === 0) return target === last ? target - 2 : target + 1
  return target
}

function matchesCronDayOfMonth(field: string, year: number, month: number, day: number): boolean {
  if (matchesCronField(field, day, 1, 31)) return true
  for (const token of field.toUpperCase().split(',')) {
    if (token === 'L' && day === lastDayOfMonth(year, month)) return true
    const offset = token.match(/^L-(\d{1,2})$/)
    if (offset && day === lastDayOfMonth(year, month) - Number(offset[1])) return true
    const weekday = token.match(/^(\d{1,2}|L)W$/)
    if (weekday) {
      const target = weekday[1] === 'L' ? lastDayOfMonth(year, month) : Number(weekday[1])
      if (day === nearestWeekday(year, month, target)) return true
    }
  }
  return false
}

function matchesCronDayOfWeek(
  field: string,
  year: number,
  month: number,
  day: number,
  weekday: number
): boolean {
  if (
    matchesCronField(field, weekday, 0, 6) ||
    (weekday === 0 && matchesCronField(field, 7, 0, 6))
  ) {
    return true
  }
  for (const token of field.toUpperCase().split(',')) {
    const last = token.match(/^([0-7])L$/)
    if (last && Number(last[1]) % 7 === weekday && day + 7 > lastDayOfMonth(year, month)) {
      return true
    }
    const nth = token.match(/^([0-7])#([1-5])$/)
    if (nth && Number(nth[1]) % 7 === weekday && Math.floor((day - 1) / 7) + 1 === Number(nth[2])) {
      return true
    }
  }
  return false
}

const zonedFormatterCache = new Map<string, Intl.DateTimeFormat>()

function getZonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = zonedFormatterCache.get(timeZone)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
    hourCycle: 'h23',
    weekday: 'short'
  })
  zonedFormatterCache.set(timeZone, formatter)
  return formatter
}

function getZonedParts(
  timestamp: number,
  timeZone?: string
): {
  minute: number
  second: number
  hour: number
  year: number
  day: number
  month: number
  weekday: number
} {
  const date = new Date(timestamp)
  if (!timeZone || timeZone === 'UTC') {
    return {
      second: date.getUTCSeconds(),
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      year: date.getUTCFullYear(),
      day: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      weekday: date.getUTCDay()
    }
  }

  const parts = getZonedFormatter(timeZone).formatToParts(date)

  const byType = new Map(parts.map((part) => [part.type, part.value]))
  return {
    second: Number.parseInt(byType.get('second') ?? '0', 10),
    minute: Number.parseInt(byType.get('minute') ?? '0', 10),
    hour: Number.parseInt(byType.get('hour') ?? '0', 10),
    year: Number.parseInt(byType.get('year') ?? '1970', 10),
    day: Number.parseInt(byType.get('day') ?? '1', 10),
    month: Number.parseInt(byType.get('month') ?? '1', 10),
    weekday: getWeekdayIndex(byType.get('weekday') ?? 'Sun')
  }
}

function parseCronExpression(expr: string): {
  second: string
  minute: string
  hour: string
  dayOfMonth: string
  month: string
  dayOfWeek: string
} | null {
  const normalized = CRON_NICKNAMES[expr.trim().toLowerCase()] ?? expr.trim()
  const parts = normalized.split(/\s+/)
  if (parts.length === 5 || parts.length === 6) {
    parts[parts.length - 2] = normalizeNamedCronField(parts[parts.length - 2], MONTH_NAMES, 1)
    parts[parts.length - 1] = normalizeNamedCronField(parts[parts.length - 1], WEEKDAY_NAMES, 0)
  }
  if (parts.length === 5) {
    return {
      second: '0',
      minute: parts[0],
      hour: parts[1],
      dayOfMonth: parts[2],
      month: parts[3],
      dayOfWeek: parts[4]
    }
  }
  if (parts.length === 6) {
    return {
      second: parts[0],
      minute: parts[1],
      hour: parts[2],
      dayOfMonth: parts[3],
      month: parts[4],
      dayOfWeek: parts[5]
    }
  }
  return null
}

function matchesCronMinuteWindow(
  parsed: NonNullable<ReturnType<typeof parseCronExpression>>,
  timestamp: number,
  timeZone?: string
): boolean {
  const zoned = getZonedParts(timestamp, timeZone)
  return (
    matchesCronField(parsed.minute, zoned.minute, 0, 59) &&
    matchesCronField(parsed.hour, zoned.hour, 0, 23) &&
    matchesCronDayOfMonth(parsed.dayOfMonth, zoned.year, zoned.month, zoned.day) &&
    matchesCronField(parsed.month, zoned.month, 1, 12) &&
    matchesCronDayOfWeek(parsed.dayOfWeek, zoned.year, zoned.month, zoned.day, zoned.weekday)
  )
}

function cronDateMayMatchWindow(
  parsed: NonNullable<ReturnType<typeof parseCronExpression>>,
  dayStart: number,
  dayEnd: number
): boolean {
  // Every IANA zone's calendar date for an instant is within one day of UTC.
  // Use a wider bound so this can only skip impossible date fields.
  const first = new Date(dayStart - 24 * 60 * MINUTE_MS)
  const last = new Date(dayEnd + 24 * 60 * MINUTE_MS)
  for (
    let day = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
    day <= last.getTime();
    day += 24 * 60 * MINUTE_MS
  ) {
    const candidate = new Date(day)
    if (
      matchesCronDayOfMonth(
        parsed.dayOfMonth,
        candidate.getUTCFullYear(),
        candidate.getUTCMonth() + 1,
        candidate.getUTCDate()
      ) &&
      matchesCronField(parsed.month, candidate.getUTCMonth() + 1, 1, 12) &&
      matchesCronDayOfWeek(
        parsed.dayOfWeek,
        candidate.getUTCFullYear(),
        candidate.getUTCMonth() + 1,
        candidate.getUTCDate(),
        candidate.getUTCDay()
      )
    ) {
      return true
    }
  }
  return false
}

export function listPlannedTimesForDay(
  job: CronJobEntry,
  dayStart: number,
  dayEnd: number,
  limit = PLANNED_TIME_LIMIT
): number[] {
  if (job.deletedAt) return []
  const { schedule } = job

  if (schedule.kind === 'at') {
    const at = schedule.at ?? null
    if (!at || at < dayStart || at > dayEnd) return []
    return [at]
  }

  if (schedule.kind === 'every') {
    const every = schedule.every ?? null
    if (!every || every < 1000) return []
    const anchor = job.lastFiredAt ?? job.updatedAt ?? job.createdAt
    const steps = Math.max(1, Math.ceil((dayStart - anchor) / every))
    const next = anchor + steps * every
    const result: number[] = []
    for (let current = next; current <= dayEnd; current += every) {
      if (current >= dayStart) result.push(current)
      if (result.length >= limit) break
    }
    return result
  }

  if (schedule.kind === 'cron' && schedule.expr) {
    const parsed = parseCronExpression(schedule.expr)
    if (!parsed || !cronDateMayMatchWindow(parsed, dayStart, dayEnd)) return []
    const seconds = expandCronFieldValues(parsed.second, 0, 59)
    if (seconds.length === 0) return []

    const result: number[] = []
    const firstMinute = Math.floor(dayStart / MINUTE_MS) * MINUTE_MS
    for (let current = firstMinute; current <= dayEnd; current += MINUTE_MS) {
      if (matchesCronMinuteWindow(parsed, current, schedule.tz)) {
        for (const second of seconds) {
          const plannedAt = current + second * 1000
          if (plannedAt < dayStart || plannedAt > dayEnd) continue
          result.push(plannedAt)
          if (result.length >= limit) break
        }
      }
      if (result.length >= limit) break
    }
    return result
  }

  return []
}

export function listDateKeysForJob(job: CronJobEntry, window: DayWindowEntry[]): string[] {
  const keys: string[] = []
  for (const day of window) {
    if (listPlannedTimesForDay(job, day.start, day.end).length > 0) {
      keys.push(day.key)
    }
  }
  return keys
}
