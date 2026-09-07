import * as React from 'react'
import {
  ArrowLeft,
  CalendarRange,
  CheckCircle2,
  Columns3,
  LayoutDashboard,
  List,
  Loader2,
  RefreshCw
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { cn } from '@renderer/lib/utils'
import {
  readTaskBoardMetadata,
  useTaskStore,
  withTaskBoardMetadata,
  type TaskItem,
  type TaskPriority,
  type TaskStatus
} from '@renderer/stores/task-store'
import { useTaskBoardStore, type TaskBoardView } from '@renderer/stores/task-board-store'

const STATUSES: Array<{ value: TaskStatus; label: string }> = [
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'in_review', label: 'In review' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'completed', label: 'Completed' }
]
const PRIORITIES: TaskPriority[] = ['low', 'medium', 'high', 'urgent']

function toDateInput(value: number | undefined): string {
  return value ? new Date(value).toISOString().slice(0, 10) : ''
}

function fromDateInput(value: string): number | undefined {
  const time = Date.parse(`${value}T00:00:00`)
  return Number.isFinite(time) ? time : undefined
}

function statusLabel(status: TaskStatus): string {
  return STATUSES.find((item) => item.value === status)?.label ?? 'Pending'
}

function priorityClass(priority: TaskPriority | undefined): string {
  return priority === 'urgent'
    ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
    : priority === 'high'
      ? 'border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300'
      : priority === 'low'
        ? 'border-slate-500/30 bg-slate-500/10 text-slate-600'
        : 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300'
}

function TaskChip({ task, onSelect }: { task: TaskItem; onSelect: () => void }): React.JSX.Element {
  const meta = readTaskBoardMetadata(task.metadata)
  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full rounded-lg border bg-background p-3 text-left shadow-sm transition-colors hover:border-primary/40 hover:bg-muted/40"
    >
      <div className="line-clamp-2 text-sm font-medium">{task.subject}</div>
      <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
        {meta.priority && (
          <span
            className={cn('rounded border px-1.5 py-0.5 capitalize', priorityClass(meta.priority))}
          >
            {meta.priority}
          </span>
        )}
        {meta.dueAt && <span>Due {new Date(meta.dueAt).toLocaleDateString()}</span>}
        {meta.tags?.slice(0, 2).map((tag) => (
          <span key={tag}>#{tag}</span>
        ))}
      </div>
    </button>
  )
}

function Dashboard({
  tasks,
  onSelect
}: {
  tasks: TaskItem[]
  onSelect: (id: string) => void
}): React.JSX.Element {
  const completed = tasks.filter((task) => task.status === 'completed').length
  const blocked = tasks.filter((task) => task.status === 'blocked').length
  const dueSoon = tasks.filter((task) => {
    const dueAt = readTaskBoardMetadata(task.metadata).dueAt
    return (
      dueAt &&
      dueAt >= Date.now() &&
      dueAt < Date.now() + 7 * 86_400_000 &&
      task.status !== 'completed'
    )
  })
  return (
    <div className="space-y-5 overflow-auto p-5">
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          ['Total tasks', tasks.length, 'text-foreground'],
          ['Completed', completed, 'text-emerald-600'],
          ['Blocked', blocked, 'text-red-600']
        ].map(([label, value, color]) => (
          <div key={String(label)} className="rounded-xl border bg-background p-4 shadow-sm">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className={cn('mt-2 text-2xl font-semibold', String(color))}>{value}</div>
          </div>
        ))}
      </div>
      <section className="rounded-xl border bg-background p-4 shadow-sm">
        <div className="mb-3 text-sm font-semibold">Due in the next 7 days</div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {dueSoon.length ? (
            dueSoon.map((task) => (
              <TaskChip key={task.id} task={task} onSelect={() => onSelect(task.id)} />
            ))
          ) : (
            <div className="py-7 text-center text-sm text-muted-foreground">
              No scheduled deadlines.
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function Kanban({
  tasks,
  onSelect,
  move
}: {
  tasks: TaskItem[]
  onSelect: (id: string) => void
  move: (id: string, status: TaskStatus) => void
}): React.JSX.Element {
  return (
    <div className="grid min-w-[900px] grid-cols-5 gap-3 overflow-auto p-5">
      {STATUSES.map((column) => (
        <section key={column.value} className="flex min-h-0 flex-col rounded-xl border bg-muted/25">
          <div className="border-b px-3 py-2 text-xs font-semibold">
            {column.label}
            <span className="ml-1 text-muted-foreground">
              {tasks.filter((task) => task.status === column.value).length}
            </span>
          </div>
          <div className="space-y-2 overflow-auto p-2">
            {tasks
              .filter((task) => task.status === column.value)
              .map((task) => (
                <div key={task.id} className="space-y-1">
                  <TaskChip task={task} onSelect={() => onSelect(task.id)} />
                  <select
                    aria-label={`Move ${task.subject}`}
                    className="w-full rounded border bg-background px-2 py-1 text-[11px]"
                    value={task.status}
                    onChange={(event) => move(task.id, event.target.value as TaskStatus)}
                  >
                    {STATUSES.map((status) => (
                      <option key={status.value} value={status.value}>
                        {status.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function TaskList({
  tasks,
  onSelect
}: {
  tasks: TaskItem[]
  onSelect: (id: string) => void
}): React.JSX.Element {
  return (
    <div className="overflow-auto p-5">
      <div className="min-w-[720px] overflow-hidden rounded-xl border bg-background">
        <div className="grid grid-cols-[minmax(220px,1fr)_130px_110px_140px] gap-3 border-b bg-muted/30 px-4 py-2 text-xs font-semibold text-muted-foreground">
          <span>Task</span>
          <span>Status</span>
          <span>Priority</span>
          <span>Due date</span>
        </div>
        {tasks.map((task) => {
          const meta = readTaskBoardMetadata(task.metadata)
          return (
            <button
              key={task.id}
              type="button"
              onClick={() => onSelect(task.id)}
              className="grid w-full grid-cols-[minmax(220px,1fr)_130px_110px_140px] gap-3 border-b px-4 py-3 text-left text-sm last:border-0 hover:bg-muted/40"
            >
              <span className="truncate font-medium">{task.subject}</span>
              <span>{statusLabel(task.status)}</span>
              <span className="capitalize">{meta.priority ?? 'medium'}</span>
              <span>{meta.dueAt ? new Date(meta.dueAt).toLocaleDateString() : '—'}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Gantt({
  tasks,
  onSelect
}: {
  tasks: TaskItem[]
  onSelect: (id: string) => void
}): React.JSX.Element {
  const scheduled = tasks.filter((task) => {
    const meta = readTaskBoardMetadata(task.metadata)
    return meta.startAt || meta.dueAt
  })
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const start = now.getTime() - 3 * 86_400_000
  const total = 21 * 86_400_000
  return (
    <div className="overflow-auto p-5">
      <div className="min-w-[760px] rounded-xl border bg-background p-4">
        <div className="mb-3 text-xs text-muted-foreground">
          Three-week schedule (drag-free, edited from task details)
        </div>
        {scheduled.length ? (
          scheduled.map((task) => {
            const meta = readTaskBoardMetadata(task.metadata)
            const taskStart = meta.startAt ?? meta.dueAt ?? start
            const taskEnd = Math.max(meta.dueAt ?? taskStart + 86_400_000, taskStart + 86_400_000)
            const left = Math.max(0, Math.min(100, ((taskStart - start) / total) * 100))
            const width = Math.max(3, Math.min(100 - left, ((taskEnd - taskStart) / total) * 100))
            return (
              <button
                key={task.id}
                type="button"
                onClick={() => onSelect(task.id)}
                className="grid w-full grid-cols-[190px_1fr] items-center gap-3 py-2 text-left"
              >
                <span className="truncate text-sm font-medium">{task.subject}</span>
                <span className="relative h-7 rounded bg-muted/50">
                  <span
                    className="absolute top-1 h-5 rounded bg-primary/75 px-2 text-[10px] leading-5 text-primary-foreground"
                    style={{ left: `${left}%`, width: `${width}%` }}
                  >
                    {statusLabel(task.status)}
                  </span>
                </span>
              </button>
            )
          })
        ) : (
          <div className="py-10 text-center text-sm text-muted-foreground">
            Add a start or due date in task details to place it on the schedule.
          </div>
        )}
      </div>
    </div>
  )
}

export function TaskBoardPage({ onBack }: { onBack: () => void }): React.JSX.Element {
  const { tasks, loading, view, selectedTaskId, load, setView, selectTask } = useTaskBoardStore()
  const task = tasks.find((item) => item.id === selectedTaskId) ?? null
  React.useEffect(() => {
    void load()
  }, [load])
  const update = React.useCallback((id: string, patch: Partial<TaskItem>) => {
    const updated = useTaskStore.getState().updateTask(id, patch)
    if (!updated) return
    useTaskBoardStore.setState((state) => ({
      tasks: state.tasks.map((item) => (item.id === id ? updated : item))
    }))
  }, [])
  const updateBoard = React.useCallback(
    (id: string, patch: Parameters<typeof withTaskBoardMetadata>[1]) => {
      const current = tasks.find((item) => item.id === id)
      if (current) update(id, { metadata: withTaskBoardMetadata(current.metadata, patch) })
    },
    [tasks, update]
  )
  const views: Array<{ value: TaskBoardView; label: string; icon: React.ReactNode }> = [
    { value: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="size-4" /> },
    { value: 'kanban', label: 'Kanban', icon: <Columns3 className="size-4" /> },
    { value: 'list', label: 'List', icon: <List className="size-4" /> },
    { value: 'gantt', label: 'Gantt', icon: <CalendarRange className="size-4" /> }
  ]
  return (
    <div className="flex h-full min-w-0 flex-col bg-muted/10">
      <header className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1 size-4" />
          Schedule
        </Button>
        <div className="mx-1 h-5 border-l" />
        {views.map((item) => (
          <Button
            key={item.value}
            variant={view === item.value ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setView(item.value)}
          >
            {item.icon}
            <span className="ml-1">{item.label}</span>
          </Button>
        ))}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void load()}
          aria-label="Refresh task board"
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">
        {' '}
        <main className="min-w-0 flex-1 overflow-hidden">
          {view === 'dashboard' ? (
            <Dashboard tasks={tasks} onSelect={selectTask} />
          ) : view === 'kanban' ? (
            <Kanban
              tasks={tasks}
              onSelect={selectTask}
              move={(id, status) => update(id, { status })}
            />
          ) : view === 'list' ? (
            <TaskList tasks={tasks} onSelect={selectTask} />
          ) : (
            <Gantt tasks={tasks} onSelect={selectTask} />
          )}
        </main>
        {task && (
          <aside className="w-80 shrink-0 overflow-auto border-l bg-background p-4">
            <div className="mb-4 flex items-center justify-between">
              <div className="text-sm font-semibold">Task details</div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => selectTask(null)}
                aria-label="Close task details"
              >
                ×
              </Button>
            </div>
            <div className="space-y-4">
              <Input
                defaultValue={task.subject}
                onBlur={(event) =>
                  update(task.id, { subject: event.target.value.trim() || task.subject })
                }
              />
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={task.status}
                onChange={(event) => update(task.id, { status: event.target.value as TaskStatus })}
              >
                {STATUSES.map((status) => (
                  <option key={status.value} value={status.value}>
                    {status.label}
                  </option>
                ))}
              </select>
              <label className="block text-xs text-muted-foreground">
                Priority
                <select
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
                  value={readTaskBoardMetadata(task.metadata).priority ?? 'medium'}
                  onChange={(event) =>
                    updateBoard(task.id, { priority: event.target.value as TaskPriority })
                  }
                >
                  {PRIORITIES.map((priority) => (
                    <option key={priority} value={priority}>
                      {priority}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-muted-foreground">
                Tags (comma separated)
                <Input
                  className="mt-1"
                  defaultValue={readTaskBoardMetadata(task.metadata).tags?.join(', ') ?? ''}
                  onBlur={(event) =>
                    updateBoard(task.id, {
                      tags: event.target.value
                        .split(',')
                        .map((tag) => tag.trim())
                        .filter(Boolean)
                    })
                  }
                />
              </label>
              <label className="block text-xs text-muted-foreground">
                Start date
                <Input
                  className="mt-1"
                  type="date"
                  value={toDateInput(readTaskBoardMetadata(task.metadata).startAt)}
                  onChange={(event) =>
                    updateBoard(task.id, { startAt: fromDateInput(event.target.value) })
                  }
                />
              </label>
              <label className="block text-xs text-muted-foreground">
                Due date
                <Input
                  className="mt-1"
                  type="date"
                  value={toDateInput(readTaskBoardMetadata(task.metadata).dueAt)}
                  onChange={(event) =>
                    updateBoard(task.id, { dueAt: fromDateInput(event.target.value) })
                  }
                />
              </label>
              {task.description && (
                <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                  {task.description}
                </p>
              )}
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <CheckCircle2 className="size-3.5" />
                Session-linked task
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
