import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarDays, Edit3, ImageOff, Loader2, Save, Upload, UserRound, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Avatar, AvatarFallback, AvatarImage } from '@renderer/components/ui/avatar'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { IPC } from '@renderer/lib/ipc/channels'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { useChatStore } from '@renderer/stores/chat-store'
import { useSettingsStore } from '@renderer/stores/settings-store'
import { resolveIntlLocale } from '@renderer/lib/i18n-language'
import {
  getUsageActivityByModel,
  getUsageActivityByProvider,
  getUsageActivityDaily,
  getUsageActivityOverview,
  type UsageAnalyticsGroupRow,
  type UsageAnalyticsOverview
} from '@renderer/lib/usage-analytics'

const ACTIVITY_DAYS = 365
const WEEKDAY_COUNT = 7
const ACTIVITY_TOOLTIP_WIDTH = 288
const ACTIVITY_TOOLTIP_HEIGHT = 230
const ACTIVITY_TOOLTIP_OFFSET = 14

type ActivityCell = {
  key: string
  date: Date
  inRange: boolean
  isFuture: boolean
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  totalCostUsd: number
  requestCount: number
}

type ActivitySummary = {
  totalTokens: number
  peakTokens: number
  peakDate: string | null
  activeDays: number
  currentStreak: number
  longestStreak: number
  averageActiveDayTokens: number
}

type ActivityWeek = ActivityCell[]

type ActivityTooltipState = {
  cell: ActivityCell
  x: number
  y: number
}

function toNumber(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function startOfDay(date: Date): Date {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

function endOfDay(date: Date): Date {
  const next = new Date(date)
  next.setHours(23, 59, 59, 999)
  return next
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + amount)
  return next
}

function startOfWeek(date: Date): Date {
  const next = startOfDay(date)
  next.setDate(next.getDate() - next.getDay())
  return next
}

function endOfWeek(date: Date): Date {
  const next = startOfDay(date)
  next.setDate(next.getDate() + (WEEKDAY_COUNT - 1 - next.getDay()))
  return next
}

function getRowTotalTokens(row: UsageAnalyticsGroupRow | undefined): number {
  if (!row) return 0
  return (
    toNumber(row.input_tokens) +
    toNumber(row.output_tokens) +
    toNumber(row.cache_creation_tokens) +
    toNumber(row.cache_read_tokens)
  )
}

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)

  if (words.length === 0) return 'OC'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase()
}

function trimCompactNumber(value: string): string {
  return value.replace(/\.0(?=[KMBT]$)/, '').replace(/(\.\d*[1-9])0(?=[KMBT]$)/, '$1')
}

function formatTokenCompact(value: number, locale: string): string {
  const normalized = Math.max(0, value)
  const formatted = new Intl.NumberFormat(locale, {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: normalized >= 100_000 ? 1 : 2
  }).format(normalized)

  return trimCompactNumber(formatted)
}

function formatInteger(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(Math.max(0, Math.round(value)))
}

function formatUsd(value: number): string {
  const normalized = Math.max(0, value)
  if (normalized === 0) return '$0'
  if (normalized < 0.01) return `$${normalized.toFixed(6)}`
  if (normalized < 1) return `$${normalized.toFixed(4)}`
  return `$${normalized.toFixed(2)}`
}

function getActivityLevel(totalTokens: number, peakTokens: number): number {
  if (totalTokens <= 0 || peakTokens <= 0) return 0

  const ratio = totalTokens / peakTokens
  if (ratio >= 0.75) return 4
  if (ratio >= 0.45) return 3
  if (ratio >= 0.2) return 2
  return 1
}

function getActivityTone(level: number): string {
  switch (level) {
    case 4:
      return 'border-sky-500/70 bg-sky-500 shadow-[0_0_0_1px_hsl(var(--background))]'
    case 3:
      return 'border-sky-500/50 bg-sky-500/70'
    case 2:
      return 'border-sky-500/30 bg-sky-500/40'
    case 1:
      return 'border-sky-500/20 bg-sky-500/20'
    default:
      return 'border-border/30 bg-muted/45'
  }
}

function getActivityTooltipPosition(clientX: number, clientY: number): { x: number; y: number } {
  if (typeof window === 'undefined') {
    return {
      x: clientX + ACTIVITY_TOOLTIP_OFFSET,
      y: clientY + ACTIVITY_TOOLTIP_OFFSET
    }
  }

  const viewportPadding = 8
  const maxX = window.innerWidth - ACTIVITY_TOOLTIP_WIDTH - viewportPadding
  const maxY = window.innerHeight - ACTIVITY_TOOLTIP_HEIGHT - viewportPadding
  const preferredX = clientX + ACTIVITY_TOOLTIP_OFFSET
  const preferredY = clientY + ACTIVITY_TOOLTIP_OFFSET
  const x =
    preferredX > maxX ? clientX - ACTIVITY_TOOLTIP_WIDTH - ACTIVITY_TOOLTIP_OFFSET : preferredX
  const y =
    preferredY > maxY ? clientY - ACTIVITY_TOOLTIP_HEIGHT - ACTIVITY_TOOLTIP_OFFSET : preferredY

  return {
    x: Math.max(viewportPadding, Math.min(x, maxX)),
    y: Math.max(viewportPadding, Math.min(y, maxY))
  }
}

function buildActivityWeeks(
  daily: UsageAnalyticsGroupRow[],
  rangeStart: Date,
  today: Date
): { weeks: ActivityWeek[]; byDay: Map<string, UsageAnalyticsGroupRow> } {
  const byDay = new Map<string, UsageAnalyticsGroupRow>()

  for (const row of daily) {
    const day = typeof row.day === 'string' ? row.day : null
    if (day) byDay.set(day, row)
  }

  const calendarStart = startOfWeek(rangeStart)
  const calendarEnd = endOfWeek(today)
  const weeks: ActivityWeek[] = []
  let cursor = calendarStart

  while (cursor.getTime() <= calendarEnd.getTime()) {
    const week: ActivityWeek = []

    for (let dayIndex = 0; dayIndex < WEEKDAY_COUNT; dayIndex += 1) {
      const date = addDays(cursor, dayIndex)
      const key = formatDateKey(date)
      const row = byDay.get(key)

      week.push({
        key,
        date,
        inRange: date.getTime() >= rangeStart.getTime() && date.getTime() <= today.getTime(),
        isFuture: date.getTime() > today.getTime(),
        totalTokens: getRowTotalTokens(row),
        inputTokens: toNumber(row?.input_tokens),
        outputTokens: toNumber(row?.output_tokens),
        cacheCreationTokens: toNumber(row?.cache_creation_tokens),
        cacheReadTokens: toNumber(row?.cache_read_tokens),
        reasoningTokens: toNumber(row?.reasoning_tokens),
        totalCostUsd: toNumber(row?.total_cost_usd),
        requestCount: toNumber(row?.request_count)
      })
    }

    weeks.push(week)
    cursor = addDays(cursor, WEEKDAY_COUNT)
  }

  return { weeks, byDay }
}

function buildActivitySummary(
  byDay: Map<string, UsageAnalyticsGroupRow>,
  overview: UsageAnalyticsOverview | null,
  rangeStart: Date,
  today: Date
): ActivitySummary {
  const totalTokens =
    toNumber(overview?.input_tokens) +
    toNumber(overview?.output_tokens) +
    toNumber(overview?.cache_creation_tokens) +
    toNumber(overview?.cache_read_tokens)
  let activeDays = 0
  let peakTokens = 0
  let peakDate: string | null = null
  let currentStreak = 0
  let longestStreak = 0
  let runningStreak = 0
  let cursor = rangeStart

  while (cursor.getTime() <= today.getTime()) {
    const key = formatDateKey(cursor)
    const tokens = getRowTotalTokens(byDay.get(key))

    if (tokens > 0) {
      activeDays += 1
      runningStreak += 1
      longestStreak = Math.max(longestStreak, runningStreak)
    } else {
      runningStreak = 0
    }

    if (tokens > peakTokens) {
      peakTokens = tokens
      peakDate = key
    }

    cursor = addDays(cursor, 1)
  }

  cursor = today
  while (cursor.getTime() >= rangeStart.getTime()) {
    const tokens = getRowTotalTokens(byDay.get(formatDateKey(cursor)))
    if (tokens <= 0) break
    currentStreak += 1
    cursor = addDays(cursor, -1)
  }

  return {
    totalTokens,
    peakTokens,
    peakDate,
    activeDays,
    currentStreak,
    longestStreak,
    averageActiveDayTokens: activeDays > 0 ? totalTokens / activeDays : 0
  }
}

function StatTile({
  label,
  value,
  detail
}: {
  label: string
  value: string
  detail?: string | null
}): React.JSX.Element {
  return (
    <div className="min-w-0 border-border/50 px-4 py-3 sm:border-l first:sm:border-l-0">
      <div className="truncate text-lg font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground">{label}</div>
      {detail ? (
        <div className="mt-1 truncate text-[11px] text-muted-foreground/70">{detail}</div>
      ) : null}
    </div>
  )
}

function ActivityHeatmap({
  weeks,
  summary,
  tokenLocale
}: {
  weeks: ActivityWeek[]
  summary: ActivitySummary
  tokenLocale: string
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [activityTooltip, setActivityTooltip] = useState<ActivityTooltipState | null>(null)
  const monthFormatter = useMemo(
    () => new Intl.DateTimeFormat(tokenLocale, { month: 'short' }),
    [tokenLocale]
  )
  const dayFormatter = useMemo(
    () => new Intl.DateTimeFormat(tokenLocale, { year: 'numeric', month: 'short', day: 'numeric' }),
    [tokenLocale]
  )
  const monthLabels = useMemo(() => {
    const labels: Array<{ weekIndex: number; label: string }> = []

    weeks.forEach((week, weekIndex) => {
      const firstOfMonth = week.find((cell) => cell.inRange && cell.date.getDate() === 1)
      if (firstOfMonth) {
        labels.push({ weekIndex, label: monthFormatter.format(firstOfMonth.date) })
      }
    })

    const firstCell = weeks[0]?.find((cell) => cell.inRange)
    if (firstCell && labels[0]?.weekIndex !== 0) {
      labels.unshift({ weekIndex: 0, label: monthFormatter.format(firstCell.date) })
    }

    return labels
  }, [monthFormatter, weeks])

  const legendLevels = [0, 1, 2, 3, 4]
  const tooltipDetail = activityTooltip
    ? {
        date: dayFormatter.format(activityTooltip.cell.date),
        tokens: formatInteger(activityTooltip.cell.totalTokens, tokenLocale),
        compactTokens: formatTokenCompact(activityTooltip.cell.totalTokens, tokenLocale),
        requests: formatInteger(activityTooltip.cell.requestCount, tokenLocale),
        cost: formatUsd(activityTooltip.cell.totalCostUsd),
        rows: [
          {
            label: t('profile.activity.tooltip.inputTokens', { defaultValue: 'Input' }),
            value: formatTokenCompact(activityTooltip.cell.inputTokens, tokenLocale)
          },
          {
            label: t('profile.activity.tooltip.outputTokens', { defaultValue: 'Output' }),
            value: formatTokenCompact(activityTooltip.cell.outputTokens, tokenLocale)
          },
          {
            label: t('profile.activity.tooltip.cacheCreationTokens', {
              defaultValue: 'Cache write'
            }),
            value: formatTokenCompact(activityTooltip.cell.cacheCreationTokens, tokenLocale)
          },
          {
            label: t('profile.activity.tooltip.cacheReadTokens', { defaultValue: 'Cache hit' }),
            value: formatTokenCompact(activityTooltip.cell.cacheReadTokens, tokenLocale)
          },
          {
            label: t('profile.activity.tooltip.reasoningTokens', { defaultValue: 'Reasoning' }),
            value: formatTokenCompact(activityTooltip.cell.reasoningTokens, tokenLocale)
          }
        ].filter((row) => row.value !== '0')
      }
    : null

  return (
    <section className="space-y-3">
      {tooltipDetail ? (
        <div
          className="pointer-events-none fixed z-50 w-72 rounded-xl border border-border/60 bg-background/95 p-3 text-left shadow-xl backdrop-blur-sm"
          style={{ left: activityTooltip?.x ?? 0, top: activityTooltip?.y ?? 0 }}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[11px] text-muted-foreground">{tooltipDetail.date}</div>
              <div className="mt-1 text-sm font-semibold tabular-nums">
                {t('profile.activity.totalTokensValue', {
                  tokens: tooltipDetail.compactTokens,
                  defaultValue: '{{tokens}} Token'
                })}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-muted-foreground">
                {t('profile.activity.tooltip.cost', { defaultValue: 'Cost' })}
              </div>
              <div className="mt-1 text-sm font-semibold tabular-nums text-sky-500">
                {tooltipDetail.cost}
              </div>
            </div>
          </div>
          <div className="mt-2 rounded-lg border border-border/40 bg-muted/15 px-2.5 py-2">
            <div className="flex items-center justify-between gap-3 text-[11px]">
              <span className="text-muted-foreground">
                {t('profile.activity.tooltip.totalRawTokens', { defaultValue: 'Total raw' })}
              </span>
              <span className="font-medium tabular-nums">{tooltipDetail.tokens}</span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-3 text-[11px]">
              <span className="text-muted-foreground">
                {t('profile.activity.tooltip.requests', { defaultValue: 'Requests' })}
              </span>
              <span className="font-medium tabular-nums">{tooltipDetail.requests}</span>
            </div>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
            {tooltipDetail.rows.map((row) => (
              <div key={row.label} className="flex min-w-0 items-center justify-between gap-2">
                <span className="truncate text-muted-foreground">{row.label}</span>
                <span className="shrink-0 font-medium tabular-nums">{row.value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">
            {t('profile.activity.title', { defaultValue: 'Token Activity' })}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t('profile.activity.subtitle', {
              defaultValue: 'Daily token usage across the last year.'
            })}
          </p>
        </div>
        <Badge variant="outline" className="gap-1.5 border-border/60 bg-background/70 text-xs">
          <CalendarDays className="size-3.5" />
          {t('profile.activity.window', {
            count: ACTIVITY_DAYS,
            defaultValue: 'Last {{count}} days'
          })}
        </Badge>
      </div>

      <div className="overflow-x-auto pb-1">
        <div className="relative w-max min-w-full pt-5">
          <div
            className="absolute left-0 top-0 grid gap-1 text-[10px] text-muted-foreground/70"
            style={{ gridTemplateColumns: `repeat(${weeks.length}, 0.75rem)` }}
          >
            {monthLabels.map((item) => (
              <span
                key={`${item.weekIndex}-${item.label}`}
                className="whitespace-nowrap"
                style={{ gridColumnStart: item.weekIndex + 1 }}
              >
                {item.label}
              </span>
            ))}
          </div>
          <div className="grid grid-flow-col grid-rows-7 gap-1">
            {weeks.flatMap((week) =>
              week.map((cell) => {
                const level = cell.inRange
                  ? getActivityLevel(cell.totalTokens, summary.peakTokens)
                  : 0
                const formattedDate = dayFormatter.format(cell.date)
                const formattedTokens = formatTokenCompact(cell.totalTokens, tokenLocale)
                const title = cell.inRange
                  ? t('profile.activity.cellTitle', {
                      date: formattedDate,
                      tokens: formattedTokens,
                      requests: formatInteger(cell.requestCount, tokenLocale),
                      cost: formatUsd(cell.totalCostUsd),
                      defaultValue: '{{date}}: {{tokens}} Token, {{requests}} requests, {{cost}}'
                    })
                  : formattedDate

                return (
                  <span
                    key={cell.key}
                    aria-label={title}
                    onMouseEnter={(event) => {
                      if (!cell.inRange || cell.isFuture) return
                      setActivityTooltip({
                        cell,
                        ...getActivityTooltipPosition(event.clientX, event.clientY)
                      })
                    }}
                    onMouseMove={(event) => {
                      if (!cell.inRange || cell.isFuture) return
                      setActivityTooltip({
                        cell,
                        ...getActivityTooltipPosition(event.clientX, event.clientY)
                      })
                    }}
                    onMouseLeave={() => setActivityTooltip(null)}
                    onFocus={(event) => {
                      if (!cell.inRange || cell.isFuture) return
                      const rect = event.currentTarget.getBoundingClientRect()
                      setActivityTooltip({
                        cell,
                        ...getActivityTooltipPosition(rect.right, rect.top)
                      })
                    }}
                    onBlur={() => setActivityTooltip(null)}
                    tabIndex={cell.inRange && !cell.isFuture ? 0 : undefined}
                    className={`size-3 rounded-[3px] border transition-transform duration-150 ${
                      cell.isFuture ? 'opacity-0' : 'hover:scale-125'
                    } ${getActivityTone(level)}`}
                  />
                )
              })
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <div>
          {t('profile.activity.activeDays', {
            count: summary.activeDays,
            defaultValue: '{{count}} active days'
          })}
        </div>
        <div className="flex items-center gap-2">
          <span>{t('profile.activity.less', { defaultValue: 'Less' })}</span>
          <span className="flex gap-1">
            {legendLevels.map((level) => (
              <span
                key={level}
                className={`size-3 rounded-[3px] border ${getActivityTone(level)}`}
              />
            ))}
          </span>
          <span>{t('profile.activity.more', { defaultValue: 'More' })}</span>
        </div>
      </div>
    </section>
  )
}

export function ProfilePanel(): React.JSX.Element {
  const { t, i18n } = useTranslation('settings')
  const settings = useSettingsStore()
  const sessionCount = useChatStore((state) => state.sessions.length)
  const tokenLocale = resolveIntlLocale(i18n.language)
  const today = useMemo(() => startOfDay(new Date()), [])
  const rangeStart = useMemo(() => addDays(today, -(ACTIVITY_DAYS - 1)), [today])
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState(settings.userName)
  const [draftAvatar, setDraftAvatar] = useState(settings.userAvatar)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const [avatarPicking, setAvatarPicking] = useState(false)
  const [loading, setLoading] = useState(true)
  const [overview, setOverview] = useState<UsageAnalyticsOverview | null>(null)
  const [daily, setDaily] = useState<UsageAnalyticsGroupRow[]>([])
  const [models, setModels] = useState<UsageAnalyticsGroupRow[]>([])
  const [providers, setProviders] = useState<UsageAnalyticsGroupRow[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (editing) return
    setDraftName(settings.userName)
    setDraftAvatar(settings.userAvatar)
    setAvatarError(null)
  }, [editing, settings.userAvatar, settings.userName])

  useEffect(() => {
    const signal = { cancelled: false }

    async function loadProfileUsage(): Promise<void> {
      setLoading(true)
      setLoadError(null)

      try {
        const query = {
          from: rangeStart.getTime(),
          to: endOfDay(today).getTime(),
          limit: 20,
          offset: 0
        }
        const [nextOverview, nextDaily, nextModels, nextProviders] = await Promise.all([
          getUsageActivityOverview(query),
          getUsageActivityDaily(query),
          getUsageActivityByModel(query),
          getUsageActivityByProvider(query)
        ])

        if (signal.cancelled) return
        setOverview(nextOverview)
        setDaily(nextDaily)
        setModels(nextModels)
        setProviders(nextProviders)
      } catch (error) {
        if (signal.cancelled) return
        setLoadError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!signal.cancelled) setLoading(false)
      }
    }

    void loadProfileUsage()

    return () => {
      signal.cancelled = true
    }
  }, [rangeStart, today])

  const { weeks, byDay } = useMemo(
    () => buildActivityWeeks(daily, rangeStart, today),
    [daily, rangeStart, today]
  )
  const summary = useMemo(
    () => buildActivitySummary(byDay, overview, rangeStart, today),
    [byDay, overview, rangeStart, today]
  )
  const profileName =
    (editing ? draftName : settings.userName).trim() ||
    t('profile.defaultName', { defaultValue: 'Ola User' })
  const avatarUrl = (editing ? draftAvatar : settings.userAvatar).trim()
  const topModel = typeof models[0]?.model_name === 'string' ? models[0].model_name : null
  const topProvider =
    typeof providers[0]?.provider_name === 'string' ? providers[0].provider_name : null
  const totalRequests = toNumber(overview?.request_count)
  const profileLabel = t('profile.localAccount', { defaultValue: 'Local profile' })
  const peakDateLabel = summary.peakDate
    ? new Intl.DateTimeFormat(tokenLocale, { month: 'short', day: 'numeric' }).format(
        new Date(`${summary.peakDate}T00:00:00`)
      )
    : null

  const handleSaveProfile = useCallback(() => {
    settings.updateSettings({
      userName: draftName.trim(),
      userAvatar: draftAvatar.trim()
    })
    setAvatarError(null)
    setEditing(false)
  }, [draftAvatar, draftName, settings])

  const handleCancelEdit = useCallback(() => {
    setDraftName(settings.userName)
    setDraftAvatar(settings.userAvatar)
    setAvatarError(null)
    setEditing(false)
  }, [settings.userAvatar, settings.userName])

  const handlePickAvatar = useCallback(async () => {
    setAvatarError(null)
    setAvatarPicking(true)

    try {
      const result = (await ipcClient.invoke(IPC.FS_IMPORT_PROFILE_AVATAR, {
        previousUrl: draftAvatar.trim() || settings.userAvatar.trim() || null
      })) as {
        canceled?: boolean
        url?: string
        error?: string
      }

      if (result.canceled) return
      if (result.error || !result.url) {
        setAvatarError(
          result.error ||
            t('profile.avatarReadFailed', { defaultValue: 'Failed to import the selected image.' })
        )
        return
      }

      setDraftAvatar(result.url)
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : String(error))
    } finally {
      setAvatarPicking(false)
    }
  }, [draftAvatar, settings.userAvatar, t])

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">
            {t('profile.title', { defaultValue: 'Profile' })}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('profile.subtitle', {
              defaultValue: 'Local identity and token activity.'
            })}
          </p>
        </div>
        {editing ? (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              onClick={handleCancelEdit}
            >
              <X className="size-3.5" />
              {t('profile.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={handleSaveProfile}>
              <Save className="size-3.5" />
              {t('profile.save', { defaultValue: 'Save' })}
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            onClick={() => setEditing(true)}
          >
            <Edit3 className="size-3.5" />
            {t('profile.edit', { defaultValue: 'Edit' })}
          </Button>
        )}
      </div>

      <section className="flex flex-col items-center gap-4 text-center">
        <div className="flex flex-col items-center gap-3">
          <div className="relative">
            <Avatar
              className="size-20 border border-border/70 bg-primary/10 text-primary shadow-sm"
              size="lg"
            >
              {avatarUrl ? <AvatarImage src={avatarUrl} alt={profileName} /> : null}
              <AvatarFallback className="bg-primary/10 text-2xl font-semibold text-primary">
                {getInitials(profileName)}
              </AvatarFallback>
            </Avatar>
            {editing ? (
              <Button
                type="button"
                size="icon"
                className="absolute -bottom-1 -right-1 size-8 rounded-full border border-background shadow-md"
                onClick={handlePickAvatar}
                disabled={avatarPicking}
                title={t('profile.chooseAvatar', { defaultValue: 'Choose avatar' })}
              >
                {avatarPicking ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Upload className="size-3.5" />
                )}
              </Button>
            ) : null}
          </div>
          {editing ? (
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                onClick={handlePickAvatar}
                disabled={avatarPicking}
              >
                {avatarPicking ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Upload className="size-3.5" />
                )}
                {t('profile.chooseAvatar', { defaultValue: 'Choose avatar' })}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 text-xs text-muted-foreground"
                onClick={() => {
                  setDraftAvatar('')
                  setAvatarError(null)
                }}
                disabled={!draftAvatar.trim()}
              >
                <ImageOff className="size-3.5" />
                {t('profile.removeAvatar', { defaultValue: 'Remove avatar' })}
              </Button>
            </div>
          ) : null}
          {avatarError ? <p className="text-xs text-destructive">{avatarError}</p> : null}
        </div>
        <div className="space-y-1">
          <h3 className="text-2xl font-semibold">{profileName}</h3>
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <UserRound className="size-3.5" />
            <span>{profileLabel}</span>
          </div>
        </div>
      </section>

      {editing ? (
        <section className="mx-auto grid w-full max-w-xl gap-3 rounded-xl border border-border/60 bg-muted/15 p-4">
          <label className="space-y-1.5">
            <span className="text-xs font-medium">
              {t('profile.displayName', { defaultValue: 'Display name' })}
            </span>
            <Input
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder={t('profile.displayNamePlaceholder', { defaultValue: 'Ola User' })}
              className="text-sm"
            />
          </label>
        </section>
      ) : null}

      <section className="grid overflow-hidden rounded-xl border border-border/60 bg-background/70 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] sm:grid-cols-5">
        <StatTile
          label={t('profile.stats.totalTokens', { defaultValue: 'Total Tokens' })}
          value={formatTokenCompact(summary.totalTokens, tokenLocale)}
        />
        <StatTile
          label={t('profile.stats.peakTokens', { defaultValue: 'Peak Day Tokens' })}
          value={formatTokenCompact(summary.peakTokens, tokenLocale)}
          detail={peakDateLabel}
        />
        <StatTile
          label={t('profile.stats.activeDays', { defaultValue: 'Active Days' })}
          value={formatInteger(summary.activeDays, tokenLocale)}
        />
        <StatTile
          label={t('profile.stats.currentStreak', { defaultValue: 'Current Streak' })}
          value={t('profile.stats.daysValue', {
            count: summary.currentStreak,
            defaultValue: '{{count}} days'
          })}
        />
        <StatTile
          label={t('profile.stats.longestStreak', { defaultValue: 'Longest Streak' })}
          value={t('profile.stats.daysValue', {
            count: summary.longestStreak,
            defaultValue: '{{count}} days'
          })}
        />
      </section>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('profile.loading', { defaultValue: 'Loading profile activity...' })}
        </div>
      ) : loadError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {t('profile.loadFailed', {
            error: loadError,
            defaultValue: 'Failed to load activity: {{error}}'
          })}
        </div>
      ) : (
        <ActivityHeatmap weeks={weeks} summary={summary} tokenLocale={tokenLocale} />
      )}

      <section className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">
            {t('profile.insights.title', { defaultValue: 'Activity Insights' })}
          </h3>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">
                {t('profile.insights.averageActiveDay', { defaultValue: 'Average active day' })}
              </span>
              <span className="font-medium tabular-nums">
                {formatTokenCompact(summary.averageActiveDayTokens, tokenLocale)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">
                {t('profile.insights.requests', { defaultValue: 'Requests' })}
              </span>
              <span className="font-medium tabular-nums">
                {formatInteger(totalRequests, tokenLocale)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">
                {t('profile.insights.sessions', { defaultValue: 'Sessions' })}
              </span>
              <span className="font-medium tabular-nums">
                {formatInteger(sessionCount, tokenLocale)}
              </span>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold">
            {t('profile.insights.favorites', { defaultValue: 'Most Used' })}
          </h3>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">
                {t('profile.insights.model', { defaultValue: 'Model' })}
              </span>
              <span className="min-w-0 truncate font-medium">{topModel ?? '-'}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">
                {t('profile.insights.provider', { defaultValue: 'Provider' })}
              </span>
              <span className="min-w-0 truncate font-medium">{topProvider ?? '-'}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
