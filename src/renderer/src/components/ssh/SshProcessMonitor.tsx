import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Loader2, RefreshCw, Search, Skull, X } from 'lucide-react'
import { toast } from 'sonner'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { cn } from '@renderer/lib/utils'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@renderer/components/ui/alert-dialog'

const REFRESH_INTERVAL_MS = 3000

// htop-style process table. Polls an extended `ps` over the existing ssh:exec
// channel (separate from the interactive shell) and supports sort / filter /
// kill — all without any new IPC.
const PROCESS_COMMAND =
  'LC_ALL=C ps -eo pid,user,pri,ni,vsz,rss,stat,pcpu,pmem,time,comm --sort=-pcpu 2>/dev/null'

const C = {
  bg: '#0f141b',
  panel: '#161e27',
  inner: '#1b2531',
  rowAlt: '#141b23',
  border: '#27333f',
  text: '#cbd5e0',
  textStrong: '#eef4fa',
  muted: '#7a8794',
  headerBlue: '#2b557f',
  headerText: '#dbe7f5',
  green: '#46c98b',
  yellow: '#e3b341',
  orange: '#e08a4b',
  red: '#e5534b',
  selected: '#1f3147'
} as const

type ProcessRow = {
  pid: number
  user: string
  pri: string
  ni: string
  virtKb: number
  resKb: number
  stat: string
  cpu: number
  mem: number
  time: string
  command: string
}

type SortKey = 'pid' | 'user' | 'res' | 'virt' | 'cpu' | 'mem' | 'time' | 'command'

function fmtKb(kb: number): string {
  if (!Number.isFinite(kb) || kb <= 0) return '0'
  const units = ['K', 'M', 'G', 'T']
  let value = kb
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)}${units[unit]}`
}

function timeToSeconds(time: string): number {
  // Handles `MM:SS`, `HH:MM:SS`, `D-HH:MM:SS`, `MM:SS.cc`
  let rest = time
  let days = 0
  const daySplit = rest.split('-')
  if (daySplit.length === 2) {
    days = Number(daySplit[0]) || 0
    rest = daySplit[1]
  }
  const parts = rest.split(':').map((p) => Number(p) || 0)
  let seconds = 0
  for (const part of parts) seconds = seconds * 60 + part
  return days * 86400 + seconds
}

function parseProcessTable(stdout: string): ProcessRow[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('PID'))
    .map((line) => {
      const parts = line.split(/\s+/)
      if (parts.length < 11) return null
      return {
        pid: Number(parts[0]) || 0,
        user: parts[1] ?? '',
        pri: parts[2] ?? '',
        ni: parts[3] ?? '',
        virtKb: Number(parts[4]) || 0,
        resKb: Number(parts[5]) || 0,
        stat: parts[6] ?? '',
        cpu: Number(parts[7]) || 0,
        mem: Number(parts[8]) || 0,
        time: parts[9] ?? '',
        command: parts.slice(10).join(' ')
      } as ProcessRow
    })
    .filter((row): row is ProcessRow => row !== null)
}

function sortValue(row: ProcessRow, key: SortKey): number | string {
  switch (key) {
    case 'pid':
      return row.pid
    case 'user':
      return row.user
    case 'res':
      return row.resKb
    case 'virt':
      return row.virtKb
    case 'cpu':
      return row.cpu
    case 'mem':
      return row.mem
    case 'time':
      return timeToSeconds(row.time)
    case 'command':
      return row.command
    default:
      return 0
  }
}

export function SshProcessMonitor({
  connectionId,
  connectionName,
  host,
  onClose
}: {
  connectionId: string
  connectionName: string
  host: string
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation('ssh')
  const [rows, setRows] = useState<ProcessRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('cpu')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [selectedPid, setSelectedPid] = useState<number | null>(null)
  const [killTarget, setKillTarget] = useState<ProcessRow | null>(null)
  const inFlightRef = useRef(false)
  const hasLoadedRef = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      if (!hasLoadedRef.current) setLoading(true)
      const result = (await ipcClient.invoke(IPC.SSH_EXEC, {
        connectionId,
        command: PROCESS_COMMAND,
        timeout: 15000
      })) as { stdout?: string; stderr?: string; exitCode?: number; error?: string }
      if (result.error) throw new Error(result.error)
      if (result.exitCode && result.exitCode !== 0 && result.stderr) {
        throw new Error(result.stderr)
      }
      setRows(parseProcessTable(String(result.stdout ?? '')))
      setError(null)
      hasLoadedRef.current = true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      inFlightRef.current = false
      setLoading(false)
    }
  }, [connectionId])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = needle
      ? rows.filter(
          (row) =>
            row.command.toLowerCase().includes(needle) ||
            row.user.toLowerCase().includes(needle) ||
            String(row.pid).includes(needle)
        )
      : rows
    const dir = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const av = sortValue(a, sortKey)
      const bv = sortValue(b, sortKey)
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
  }, [rows, query, sortKey, sortDir])

  const summary = useMemo(() => {
    const running = rows.filter((row) => row.stat.startsWith('R')).length
    const totalCpu = rows.reduce((acc, row) => acc + row.cpu, 0)
    const totalMem = rows.reduce((acc, row) => acc + row.mem, 0)
    return { tasks: rows.length, running, totalCpu, totalMem }
  }, [rows])

  const toggleSort = (key: SortKey): void => {
    if (key === sortKey) {
      setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'command' || key === 'user' ? 'asc' : 'desc')
    }
  }

  const runKill = async (proc: ProcessRow, force: boolean): Promise<void> => {
    setKillTarget(null)
    try {
      const result = (await ipcClient.invoke(IPC.SSH_EXEC, {
        connectionId,
        command: `kill -${force ? 'KILL' : 'TERM'} ${proc.pid}`,
        timeout: 8000
      })) as { exitCode?: number; stderr?: string; error?: string }
      if (result.error) throw new Error(result.error)
      if (result.exitCode && result.exitCode !== 0) {
        throw new Error(result.stderr || `exit ${result.exitCode}`)
      }
      toast.success(
        t('workspace.processMonitor.killed', {
          defaultValue: 'Sent signal to {{pid}}',
          pid: proc.pid
        })
      )
      window.setTimeout(() => void refresh(), 400)
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const columns: Array<{ key: SortKey | null; label: string; className: string; align?: string }> =
    [
      { key: 'pid', label: 'PID', className: 'w-[68px]' },
      { key: 'user', label: 'USER', className: 'w-[88px]' },
      { key: null, label: 'PRI', className: 'w-[44px]' },
      { key: null, label: 'NI', className: 'w-[40px]' },
      { key: 'virt', label: 'VIRT', className: 'w-[64px] text-right', align: 'right' },
      { key: 'res', label: 'RES', className: 'w-[64px] text-right', align: 'right' },
      { key: null, label: 'S', className: 'w-[36px] text-center', align: 'center' },
      { key: 'cpu', label: 'CPU%', className: 'w-[60px] text-right', align: 'right' },
      { key: 'mem', label: 'MEM%', className: 'w-[60px] text-right', align: 'right' },
      { key: 'time', label: 'TIME+', className: 'w-[84px] text-right', align: 'right' },
      { key: 'command', label: 'COMMAND', className: 'flex-1 min-w-0' }
    ]

  return (
    <div
      className="absolute inset-0 z-20 flex flex-col"
      style={{ background: C.bg, color: C.text }}
    >
      {/* Toolbar */}
      <div
        className="flex shrink-0 items-center gap-3 border-b px-3 py-2"
        style={{ borderColor: C.border }}
      >
        <div className="min-w-0">
          <div className="truncate text-[0.84rem] font-semibold" style={{ color: C.textStrong }}>
            {t('workspace.processMonitor.title', { defaultValue: 'Process monitor' })}
          </div>
          <div className="truncate text-[0.68rem]" style={{ color: C.muted }}>
            {connectionName} · {host}
          </div>
        </div>
        <div className="relative ml-auto w-[220px]">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2"
            style={{ color: C.muted }}
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('workspace.processMonitor.search', { defaultValue: 'Filter…' })}
            className="h-8 border-0 pl-7 text-[0.78rem]"
            style={{ background: C.inner, color: C.text }}
          />
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-8 rounded-[6px]"
          style={{ color: C.muted }}
          onClick={() => void refresh()}
          title={t('list.refresh')}
        >
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-8 rounded-[6px]"
          style={{ color: C.muted }}
          onClick={onClose}
          title={t('workspace.close', { defaultValue: 'Close' })}
        >
          <X className="size-4" />
        </Button>
      </div>

      {/* Summary */}
      <div
        className="flex shrink-0 items-center gap-4 border-b px-3 py-1.5 text-[0.72rem] font-mono"
        style={{ borderColor: C.border, color: C.muted }}
      >
        <span>
          {t('workspace.processMonitor.tasks', { defaultValue: 'Tasks' })}:{' '}
          <span style={{ color: C.text }}>{summary.tasks}</span>
        </span>
        <span>
          {t('workspace.processMonitor.running', { defaultValue: 'running' })}:{' '}
          <span style={{ color: C.green }}>{summary.running}</span>
        </span>
        <span>
          CPU: <span style={{ color: C.yellow }}>{summary.totalCpu.toFixed(1)}%</span>
        </span>
        <span>
          MEM: <span style={{ color: C.orange }}>{summary.totalMem.toFixed(1)}%</span>
        </span>
      </div>

      {error ? (
        <div className="px-3 py-1.5 text-[0.72rem]" style={{ color: C.red }}>
          {error}
        </div>
      ) : null}

      {/* Header */}
      <div
        className="flex shrink-0 items-center gap-2 px-3 py-1 text-[0.66rem] font-semibold uppercase tracking-[0.06em]"
        style={{ background: C.headerBlue, color: C.headerText }}
      >
        {columns.map((col) => {
          const active = col.key && col.key === sortKey
          return (
            <button
              key={col.label}
              type="button"
              disabled={!col.key}
              onClick={() => col.key && toggleSort(col.key)}
              className={cn(
                'flex items-center gap-0.5',
                col.className,
                col.align === 'right' && 'justify-end',
                col.align === 'center' && 'justify-center',
                col.key ? 'cursor-pointer hover:opacity-80' : 'cursor-default'
              )}
            >
              <span>{col.label}</span>
              {active ? (
                sortDir === 'asc' ? (
                  <ArrowUp className="size-3" />
                ) : (
                  <ArrowDown className="size-3" />
                )
              ) : null}
            </button>
          )
        })}
        <span className="w-[32px] shrink-0" />
      </div>

      {/* Rows */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visibleRows.map((row, index) => {
          const selected = row.pid === selectedPid
          return (
            <div
              key={row.pid}
              onClick={() => setSelectedPid(row.pid)}
              className="group flex items-center gap-2 px-3 py-[3px] text-[0.74rem] font-mono"
              style={{
                color: C.text,
                background: selected ? C.selected : index % 2 ? C.rowAlt : 'transparent'
              }}
            >
              <span className="w-[68px] shrink-0" style={{ color: C.muted }}>
                {row.pid}
              </span>
              <span className="w-[88px] shrink-0 truncate">{row.user}</span>
              <span className="w-[44px] shrink-0">{row.pri}</span>
              <span className="w-[40px] shrink-0">{row.ni}</span>
              <span className="w-[64px] shrink-0 text-right">{fmtKb(row.virtKb)}</span>
              <span className="w-[64px] shrink-0 text-right">{fmtKb(row.resKb)}</span>
              <span className="w-[36px] shrink-0 text-center" style={{ color: C.muted }}>
                {row.stat}
              </span>
              <span
                className="w-[60px] shrink-0 text-right"
                style={{ color: row.cpu > 50 ? C.red : row.cpu > 10 ? C.yellow : C.green }}
              >
                {row.cpu.toFixed(1)}
              </span>
              <span className="w-[60px] shrink-0 text-right" style={{ color: C.orange }}>
                {row.mem.toFixed(1)}
              </span>
              <span className="w-[84px] shrink-0 text-right" style={{ color: C.muted }}>
                {row.time}
              </span>
              <span className="min-w-0 flex-1 truncate">{row.command}</span>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  setKillTarget(row)
                }}
                className="w-[32px] shrink-0 opacity-0 transition group-hover:opacity-100"
                style={{ color: C.red }}
                title={t('workspace.processMonitor.kill', { defaultValue: 'Kill' })}
              >
                <Skull className="mx-auto size-3.5" />
              </button>
            </div>
          )
        })}
        {!loading && visibleRows.length === 0 ? (
          <div className="px-3 py-6 text-center text-[0.78rem]" style={{ color: C.muted }}>
            {t('workspace.processMonitor.empty', { defaultValue: 'No matching processes' })}
          </div>
        ) : null}
      </div>

      {loading && !hasLoadedRef.current ? (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{ background: `${C.bg}cc` }}
        >
          <Loader2 className="size-5 animate-spin" style={{ color: C.text }} />
        </div>
      ) : null}

      <AlertDialog open={killTarget !== null} onOpenChange={(open) => !open && setKillTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('workspace.processMonitor.killTitle', { defaultValue: 'Kill process?' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {killTarget
                ? t('workspace.processMonitor.killDesc', {
                    defaultValue: 'PID {{pid}} · {{command}}',
                    pid: killTarget.pid,
                    command: killTarget.command
                  })
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t('workspace.cancel', { defaultValue: 'Cancel' })}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => killTarget && void runKill(killTarget, false)}>
              {t('workspace.processMonitor.killTerm', { defaultValue: 'Terminate' })}
            </AlertDialogAction>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => killTarget && void runKill(killTarget, true)}
            >
              {t('workspace.processMonitor.killForce', { defaultValue: 'Force kill (-9)' })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
