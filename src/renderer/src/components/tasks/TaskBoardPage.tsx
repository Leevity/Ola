import * as React from 'react'
import {
  ArrowLeft,
  CalendarRange,
  CheckCircle2,
  Columns3,
  LayoutDashboard,
  List,
  Loader2,
  Plus,
  Trash2,
  RefreshCw
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { cn } from '@renderer/lib/utils'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import i18n from '@renderer/locales'
import {
  readTaskBoardMetadata,
  useTaskStore,
  withTaskBoardMetadata,
  type TaskItem,
  type TaskPriority,
  type TaskStatus
} from '@renderer/stores/task-store'
import { useTaskBoardStore, type TaskBoardView } from '@renderer/stores/task-board-store'
import { fromTaskDateInput } from '@renderer/lib/task-calendar-date'
import {
  isTerminalTaskStatus,
  TASK_BOARD_STATUS_ORDER,
  taskBoardStatusCounts
} from '@renderer/lib/task-board-status'
import { triggerBusinessTaskRun } from '@renderer/hooks/use-chat-actions'
import { useChatStore } from '@renderer/stores/chat-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'

const STATUS_FALLBACKS: Record<TaskStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  in_review: 'In review',
  blocked: 'Blocked',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled'
}
const STATUSES = TASK_BOARD_STATUS_ORDER.map((value) => ({
  value,
  label: STATUS_FALLBACKS[value]
}))
const PRIORITIES: TaskPriority[] = ['low', 'medium', 'high', 'urgent']

function boardText(
  key: string,
  fallback: string,
  options?: Record<string, string | number>
): string {
  return i18n.t(`layout:taskBoard.${key}`, { defaultValue: fallback, ...options })
}

function statusLabel(status: TaskStatus): string {
  return boardText(`status.${status}`, STATUS_FALLBACKS[status])
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
      className="w-full rounded-lg border bg-background p-3 text-left shadow-sm transition-colors hover:border-primary/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <div className="line-clamp-2 text-sm font-medium">{task.subject}</div>
      <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
        {meta.priority && (
          <span
            className={cn('rounded border px-1.5 py-0.5 capitalize', priorityClass(meta.priority))}
          >
            {boardText(`priority.${meta.priority}`, meta.priority)}
          </span>
        )}
        {meta.dueAt && (
          <span>
            {boardText('due', 'Due')} {new Date(meta.dueAt).toLocaleDateString()}
          </span>
        )}
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
  const statusCounts = taskBoardStatusCounts(tasks)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const nextWeek = new Date(today)
  nextWeek.setDate(nextWeek.getDate() + 7)
  const dueSoon = tasks.filter((task) => {
    const dueAt = readTaskBoardMetadata(task.metadata).dueAt
    return (
      dueAt &&
      dueAt >= today.getTime() &&
      dueAt < nextWeek.getTime() &&
      !isTerminalTaskStatus(task.status)
    )
  })
  return (
    <div className="space-y-5 overflow-auto p-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border bg-background p-4 shadow-sm">
          <div className="text-xs text-muted-foreground">
            {boardText('totalTasks', 'Total tasks')}
          </div>
          <div className="mt-2 text-2xl font-semibold">{tasks.length}</div>
        </div>
        {STATUSES.map((status) => (
          <div key={status.value} className="rounded-xl border bg-background p-4 shadow-sm">
            <div className="text-xs text-muted-foreground">
              {boardText(`status.${status.value}`, status.label)}
            </div>
            <div className="mt-2 text-2xl font-semibold">{statusCounts[status.value]}</div>
          </div>
        ))}
      </div>
      <section className="rounded-xl border bg-background p-4 shadow-sm">
        <div className="mb-3 text-sm font-semibold">
          {boardText('dueSoon', 'Due in the next 7 days')}
        </div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {dueSoon.length ? (
            dueSoon.map((task) => (
              <TaskChip key={task.id} task={task} onSelect={() => onSelect(task.id)} />
            ))
          ) : (
            <div className="py-7 text-center text-sm text-muted-foreground">
              {boardText('noDeadlines', 'No scheduled deadlines.')}
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
    <div className="h-full w-full overflow-auto">
      <div className="grid min-w-[1050px] grid-cols-7 gap-3 p-5">
        {STATUSES.map((column) => (
          <section
            key={column.value}
            className="flex min-h-0 flex-col rounded-xl border bg-muted/25"
          >
            <div className="border-b px-3 py-2 text-xs font-semibold">
              {boardText(`status.${column.value}`, column.label)}
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
                      aria-label={boardText('moveTask', 'Move {{subject}}', {
                        subject: task.subject
                      })}
                      className="w-full rounded border bg-background px-2 py-1 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={task.status}
                      onChange={(event) => move(task.id, event.target.value as TaskStatus)}
                    >
                      {STATUSES.map((status) => (
                        <option key={status.value} value={status.value}>
                          {boardText(`status.${status.value}`, status.label)}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
            </div>
          </section>
        ))}
      </div>
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
          <span>{boardText('task', 'Task')}</span>
          <span>{boardText('statusLabel', 'Status')}</span>
          <span>{boardText('priorityLabel', 'Priority')}</span>
          <span>{boardText('dueDate', 'Due date')}</span>
        </div>
        {tasks.map((task) => {
          const meta = readTaskBoardMetadata(task.metadata)
          return (
            <button
              key={task.id}
              type="button"
              onClick={() => onSelect(task.id)}
              className="grid w-full grid-cols-[minmax(220px,1fr)_130px_110px_140px] gap-3 border-b px-4 py-3 text-left text-sm last:border-0 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="truncate font-medium">{task.subject}</span>
              <span>{statusLabel(task.status)}</span>
              <span className="capitalize">
                {boardText(`priority.${meta.priority ?? 'medium'}`, meta.priority ?? 'medium')}
              </span>
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
          {boardText('threeWeekSchedule', 'Three-week schedule (edited from task details)')}
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
                className="grid w-full grid-cols-[190px_1fr] items-center gap-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
            {boardText(
              'noSchedule',
              'Add a start or due date in task details to place it on the schedule.'
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function TaskBoardPage({ onBack }: { onBack: () => void }): React.JSX.Element {
  useTranslation('layout')
  const { tasks, loading, error, view, selectedTaskId, load, setView, selectTask } =
    useTaskBoardStore()
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const sessions = useChatStore((state) => state.sessions)
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const availableSessions = sessions.filter(
    (session) => (session.workspaceId ?? 'local-personal') === workspaceId
  )
  const task = tasks.find((item) => item.id === selectedTaskId) ?? null
  const [createOpen, setCreateOpen] = React.useState(false)
  const [createSessionId, setCreateSessionId] = React.useState('')
  const [createSubject, setCreateSubject] = React.useState('')
  const [createDescription, setCreateDescription] = React.useState('')
  const [createSaving, setCreateSaving] = React.useState(false)
  const [createError, setCreateError] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deleteSaving, setDeleteSaving] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState(false)
  const [detailSubject, setDetailSubject] = React.useState('')
  const [detailTags, setDetailTags] = React.useState('')
  const [detailSaveError, setDetailSaveError] = React.useState(false)
  const [detailSaving, setDetailSaving] = React.useState(false)
  const [failedUpdate, setFailedUpdate] = React.useState<{
    taskId: string
    patch: Partial<TaskItem>
  } | null>(null)
  React.useEffect(() => {
    const selectedTask = useTaskBoardStore
      .getState()
      .tasks.find((item) => item.id === selectedTaskId)
    setDetailSubject(selectedTask?.subject ?? '')
    setDetailTags(readTaskBoardMetadata(selectedTask?.metadata).tags?.join(', ') ?? '')
    setDetailSaveError(false)
  }, [selectedTaskId])
  const detailDraftChanged = Boolean(
    task &&
    (detailSubject !== task.subject ||
      detailTags !== (readTaskBoardMetadata(task.metadata).tags?.join(', ') ?? ''))
  )
  const openCreate = (): void => {
    setCreateSessionId(
      availableSessions.some((session) => session.id === activeSessionId)
        ? (activeSessionId ?? '')
        : (availableSessions[0]?.id ?? '')
    )
    setCreateSubject('')
    setCreateDescription('')
    setCreateError(false)
    setCreateOpen(true)
  }
  const createTask = async (): Promise<void> => {
    if (createSaving || !createSubject.trim()) return
    if (!availableSessions.some((session) => session.id === createSessionId)) {
      setCreateError(true)
      return
    }
    setCreateSaving(true)
    setCreateError(false)
    try {
      const now = Date.now()
      const created = await useTaskStore.getState().addTask({
        id: crypto.randomUUID(),
        sessionId: createSessionId,
        subject: createSubject.trim(),
        description: createDescription.trim() || createSubject.trim(),
        status: 'pending',
        owner: null,
        blocks: [],
        blockedBy: [],
        createdAt: now,
        updatedAt: now
      })
      setCreateOpen(false)
      if (workspaceId === useWorkspaceStore.getState().activeWorkspaceId) {
        await load()
        selectTask(created.id)
      }
    } catch (error) {
      setCreateError(true)
      console.error('[TaskBoardPage] Failed to create task:', error)
    } finally {
      setCreateSaving(false)
    }
  }
  const deleteTask = async (): Promise<void> => {
    if (!task || deleteSaving) return
    setDeleteSaving(true)
    setDeleteError(false)
    try {
      if (!(await useTaskStore.getState().deleteTask(task.id))) throw new Error('TASK_NOT_FOUND')
      setDeleteOpen(false)
      selectTask(null)
      if (workspaceId === useWorkspaceStore.getState().activeWorkspaceId) await load()
    } catch (error) {
      setDeleteError(true)
      console.error('[TaskBoardPage] Failed to delete task:', error)
    } finally {
      setDeleteSaving(false)
    }
  }
  const saveDetailDraft = async (): Promise<void> => {
    if (!task || detailSaving || !detailDraftChanged) return
    setDetailSaving(true)
    setDetailSaveError(false)
    try {
      const currentMetadata = readTaskBoardMetadata(task.metadata)
      const updated = await useTaskStore.getState().updateTask(task.id, {
        subject: detailSubject.trim() || task.subject,
        metadata: withTaskBoardMetadata(task.metadata, {
          tags: detailTags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
          priority: currentMetadata.priority,
          startDate: currentMetadata.startDate,
          dueDate: currentMetadata.dueDate
        })
      })
      if (!updated) throw new Error('TASK_NOT_FOUND')
      useTaskBoardStore.setState((state) => ({
        tasks: state.tasks.map((item) => (item.id === task.id ? updated : item))
      }))
      setDetailSubject(updated.subject)
      setDetailTags(readTaskBoardMetadata(updated.metadata).tags?.join(', ') ?? '')
    } catch (error) {
      setDetailSaveError(true)
      console.error('[TaskBoardPage] Failed to save task details:', error)
    } finally {
      setDetailSaving(false)
    }
  }
  const runTask = (item: TaskItem): void => {
    if (!item.sessionId) return
    const prompt = boardText('runPrompt', 'Work on this task: {{subject}}\n\n{{description}}', {
      subject: item.subject,
      description: item.description
    })
    useChatStore.getState().setActiveSession(item.sessionId)
    useUIStore.getState().navigateToSession(item.sessionId)
    void triggerBusinessTaskRun(prompt, item.sessionId, item.id).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error))
    })
  }
  React.useEffect(() => {
    void load()
  }, [load])
  const commitUpdate = React.useCallback(async (id: string, patch: Partial<TaskItem>) => {
    try {
      const updated = await useTaskStore.getState().updateTask(id, patch)
      if (!updated) return
      useTaskBoardStore.setState((state) => ({
        tasks: state.tasks.map((item) => (item.id === id ? updated : item))
      }))
      setFailedUpdate((current) => (current?.taskId === id ? null : current))
    } catch (error) {
      setFailedUpdate({ taskId: id, patch })
      toast.error(
        error instanceof Error &&
          (error.message.includes('BUSINESS_TASK_CONFLICT') ||
            error.message.includes('BUSINESS_TASK_NOT_FOUND'))
          ? boardText(
              'conflictReloaded',
              'This task changed elsewhere. The latest version was loaded.'
            )
          : boardText('saveFailed', 'Could not save this task. Please retry.')
      )
    }
  }, [])
  const update = React.useCallback(
    (id: string, patch: Partial<TaskItem>) => void commitUpdate(id, patch),
    [commitUpdate]
  )
  const updateBoard = React.useCallback(
    (id: string, patch: Parameters<typeof withTaskBoardMetadata>[1]) => {
      const current = tasks.find((item) => item.id === id)
      if (current) update(id, { metadata: withTaskBoardMetadata(current.metadata, patch) })
    },
    [tasks, update]
  )
  const views: Array<{ value: TaskBoardView; label: string; icon: React.ReactNode }> = [
    {
      value: 'dashboard',
      label: boardText('views.dashboard', 'Dashboard'),
      icon: <LayoutDashboard className="size-4" />
    },
    {
      value: 'kanban',
      label: boardText('views.kanban', 'Kanban'),
      icon: <Columns3 className="size-4" />
    },
    { value: 'list', label: boardText('views.list', 'List'), icon: <List className="size-4" /> },
    {
      value: 'gantt',
      label: boardText('views.gantt', 'Gantt'),
      icon: <CalendarRange className="size-4" />
    }
  ]
  return (
    <div className="flex h-full min-w-0 flex-col bg-muted/10">
      <header className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1 size-4" />
          {boardText('schedule', 'Schedule')}
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
        <Button size="sm" onClick={openCreate}>
          <Plus className="mr-1 size-4" />
          {boardText('createTask', 'New task')}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void load()}
          aria-label={boardText('refresh', 'Refresh task board')}
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        </Button>
      </header>
      {failedUpdate && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-sm"
        >
          <span>{boardText('saveFailed', 'Could not save this task. Please retry.')}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void commitUpdate(failedUpdate.taskId, failedUpdate.patch)}
          >
            {boardText('retry', 'Retry')}
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {error && (
            <div role="alert" className="m-4 rounded-md border border-destructive/40 p-3 text-sm">
              <span>{boardText('loadFailed', 'Failed to load tasks. Please retry.')}</span>
              <Button variant="outline" size="sm" className="ml-3" onClick={() => void load()}>
                {boardText('retry', 'Retry')}
              </Button>
            </div>
          )}
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
          <aside className="max-h-[45%] w-full shrink-0 overflow-auto border-t bg-background p-4 lg:max-h-none lg:w-80 lg:border-t-0 lg:border-l">
            <div className="mb-4 flex items-center justify-between">
              <div className="text-sm font-semibold">{boardText('details', 'Task details')}</div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => selectTask(null)}
                aria-label={boardText('closeDetails', 'Close task details')}
              >
                ×
              </Button>
            </div>
            <div className="space-y-4">
              <Input
                aria-label={boardText('task', 'Task')}
                value={detailSubject}
                onChange={(event) => setDetailSubject(event.target.value)}
              />
              <select
                aria-label={boardText('statusLabel', 'Status')}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={task.status}
                onChange={(event) => update(task.id, { status: event.target.value as TaskStatus })}
              >
                {STATUSES.map((status) => (
                  <option key={status.value} value={status.value}>
                    {boardText(`status.${status.value}`, status.label)}
                  </option>
                ))}
              </select>
              <label className="block text-xs text-muted-foreground">
                {boardText('priorityLabel', 'Priority')}
                <select
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={readTaskBoardMetadata(task.metadata).priority ?? 'medium'}
                  onChange={(event) =>
                    updateBoard(task.id, { priority: event.target.value as TaskPriority })
                  }
                >
                  {PRIORITIES.map((priority) => (
                    <option key={priority} value={priority}>
                      {boardText(`priority.${priority}`, priority)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-muted-foreground">
                {boardText('tags', 'Tags (comma separated)')}
                <Input
                  className="mt-1"
                  value={detailTags}
                  onChange={(event) => setDetailTags(event.target.value)}
                />
              </label>
              <label className="block text-xs text-muted-foreground">
                {boardText('startDate', 'Start date')}
                <Input
                  className="mt-1"
                  type="date"
                  value={readTaskBoardMetadata(task.metadata).startDate ?? ''}
                  onChange={(event) =>
                    updateBoard(task.id, {
                      startDate:
                        fromTaskDateInput(event.target.value) !== undefined
                          ? event.target.value
                          : undefined
                    })
                  }
                />
              </label>
              <label className="block text-xs text-muted-foreground">
                {boardText('dueDate', 'Due date')}
                <Input
                  className="mt-1"
                  type="date"
                  value={readTaskBoardMetadata(task.metadata).dueDate ?? ''}
                  onChange={(event) =>
                    updateBoard(task.id, {
                      dueDate:
                        fromTaskDateInput(event.target.value) !== undefined
                          ? event.target.value
                          : undefined
                    })
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
                {boardText('sessionLinked', 'Session-linked task')}
              </div>
              {task.sessionId && (
                <Button variant="outline" size="sm" onClick={() => runTask(task)}>
                  {boardText('runTask', 'Run in session')}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="text-destructive"
                onClick={() => {
                  setDeleteError(false)
                  setDeleteOpen(true)
                }}
              >
                <Trash2 className="mr-1 size-4" />
                {boardText('deleteTask', 'Delete task')}
              </Button>
              {(detailDraftChanged || detailSaveError) && (
                <div className="space-y-2" aria-live="polite">
                  {detailSaveError && (
                    <p role="alert" className="text-xs text-destructive">
                      {boardText(
                        'detailSaveFailed',
                        'Could not save these changes. Your edits are still here; retry when ready.'
                      )}
                    </p>
                  )}
                  <Button
                    variant="default"
                    size="sm"
                    disabled={detailSaving}
                    onClick={() => void saveDetailDraft()}
                  >
                    {detailSaving
                      ? boardText('saving', 'Saving…')
                      : detailSaveError
                        ? boardText('retrySave', 'Retry save')
                        : boardText('saveChanges', 'Save changes')}
                  </Button>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
      <Dialog open={createOpen} onOpenChange={(open) => !createSaving && setCreateOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{boardText('createTask', 'New task')}</DialogTitle>
            <DialogDescription>
              {boardText('createHint', 'Choose a session and enter a task title.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {availableSessions.length ? (
              <label className="block text-sm">
                {boardText('session', 'Session')}
                <select
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={createSessionId}
                  onChange={(event) => setCreateSessionId(event.target.value)}
                >
                  {availableSessions.map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.title || session.id}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p role="alert" className="text-sm text-muted-foreground">
                {boardText('noSession', 'Create a session in this workspace first.')}
              </p>
            )}
            <label className="block text-sm">
              {boardText('taskTitle', 'Task title')}
              <Input
                className="mt-1"
                value={createSubject}
                onChange={(event) => setCreateSubject(event.target.value)}
                maxLength={500}
              />
            </label>
            <label className="block text-sm">
              {boardText('description', 'Description')}
              <textarea
                className="mt-1 min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={createDescription}
                onChange={(event) => setCreateDescription(event.target.value)}
              />
            </label>
            {createError && (
              <p role="alert" className="text-sm text-destructive">
                {boardText('createFailed', 'Could not create this task. Your draft is still here.')}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={createSaving} onClick={() => setCreateOpen(false)}>
              {boardText('cancel', 'Cancel')}
            </Button>
            <Button
              disabled={createSaving || !createSubject.trim() || !createSessionId}
              onClick={() => void createTask()}
            >
              {createSaving ? boardText('saving', 'Saving…') : boardText('createTask', 'New task')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={deleteOpen} onOpenChange={(open) => !deleteSaving && setDeleteOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{boardText('deleteTask', 'Delete task')}</DialogTitle>
            <DialogDescription>
              {boardText('deleteConfirm', 'Delete this task? This action cannot be undone.')}
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p role="alert" className="text-sm text-destructive">
              {boardText('deleteFailed', 'Could not delete this task. Please retry.')}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={deleteSaving} onClick={() => setDeleteOpen(false)}>
              {boardText('cancel', 'Cancel')}
            </Button>
            <Button variant="destructive" disabled={deleteSaving} onClick={() => void deleteTask()}>
              {deleteSaving
                ? boardText('saving', 'Saving…')
                : boardText('deleteTask', 'Delete task')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
