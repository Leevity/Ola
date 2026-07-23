import fs, { type FSWatcher } from 'node:fs'
import path from 'node:path'
import { getCodeGraphWorker } from './codegraph-worker'

const AUTO_SYNC_DEBOUNCE_MS = 1_250
const MAX_AUTO_SYNC_PROJECTS = 32
const MAX_AUTO_SYNC_DIRECTORIES = 2_000
const IGNORED_PATH_SEGMENTS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.cache'
])

type IndexedProjectList = {
  success: boolean
  projects: Array<{ root: string; state: string }>
}

type CodeGraphOperationResult = {
  success?: unknown
  errorKind?: unknown
}

type SyncEntry = {
  watchers: Map<string, FSWatcher>
  watcherSyncTimer: ReturnType<typeof setTimeout> | null
  syncingWatchers: boolean
  timer: ReturnType<typeof setTimeout> | null
  syncing: boolean
  dirty: boolean
}

const entries = new Map<string, SyncEntry>()
let started = false

function isEnabled(): boolean {
  return process.env.OLA_CODEGRAPH_AUTO_SYNC !== '0'
}

function normalizeRoot(root: string): string | null {
  const trimmed = root.trim()
  if (!trimmed || !path.isAbsolute(trimmed)) return null
  return path.resolve(trimmed)
}

function isIgnoredChange(filename: string | Buffer | null): boolean {
  if (!filename) return false
  const segments = filename.toString().split(/[\\/]/).filter(Boolean)
  return segments.some((segment) => IGNORED_PATH_SEGMENTS.has(segment))
}

function isSuccess(result: unknown): result is CodeGraphOperationResult {
  return Boolean(
    result &&
    typeof result === 'object' &&
    (result as CodeGraphOperationResult).success === true &&
    (result as CodeGraphOperationResult).errorKind !== 'not_indexed'
  )
}

function isIndexedProject(project: IndexedProjectList['projects'][number]): boolean {
  return Boolean(project.root) && (project.state === 'complete' || project.state === 'partial')
}

async function collectWatchableDirectories(root: string): Promise<Set<string>> {
  const directories = new Set<string>([root])
  const queue = [root]

  while (queue.length > 0 && directories.size < MAX_AUTO_SYNC_DIRECTORIES) {
    const current = queue.shift()!
    let children: fs.Dirent[]
    try {
      children = await fs.promises.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const child of children) {
      if (!child.isDirectory() || child.isSymbolicLink() || IGNORED_PATH_SEGMENTS.has(child.name))
        continue
      const directory = path.join(current, child.name)
      directories.add(directory)
      queue.push(directory)
      if (directories.size >= MAX_AUTO_SYNC_DIRECTORIES) break
    }
  }

  return directories
}

function scheduleWatcherSync(root: string, entry: SyncEntry): void {
  if (entry.watcherSyncTimer || entry.syncingWatchers) return
  entry.watcherSyncTimer = setTimeout(() => {
    entry.watcherSyncTimer = null
    void syncWatchers(root, entry)
  }, 500)
}

function watchDirectory(root: string, entry: SyncEntry, directory: string): void {
  if (entry.watchers.has(directory)) return
  try {
    const watcher = fs.watch(directory, { recursive: false }, (_eventType, filename) => {
      if (isIgnoredChange(filename)) return
      scheduleSync(root, entry)
      scheduleWatcherSync(root, entry)
    })
    watcher.on('error', () => {
      watcher.close()
      entry.watchers.delete(directory)
    })
    entry.watchers.set(directory, watcher)
  } catch {
    // A directory can disappear between traversal and fs.watch registration.
  }
}

async function syncWatchers(root: string, entry: SyncEntry): Promise<void> {
  if (!entries.has(root) || entry.syncingWatchers) return
  entry.syncingWatchers = true
  try {
    const directories = await collectWatchableDirectories(root)
    if (!entries.has(root)) return
    for (const directory of directories) watchDirectory(root, entry, directory)
    for (const [directory, watcher] of entry.watchers) {
      if (directories.has(directory)) continue
      watcher.close()
      entry.watchers.delete(directory)
    }
  } finally {
    entry.syncingWatchers = false
  }
}

function scheduleSync(root: string, entry: SyncEntry): void {
  entry.dirty = true
  if (entry.timer || entry.syncing) return
  entry.timer = setTimeout(() => {
    entry.timer = null
    void runSync(root, entry)
  }, AUTO_SYNC_DEBOUNCE_MS)
}

async function runSync(root: string, entry: SyncEntry): Promise<void> {
  if (!entries.has(root) || !entry.dirty || entry.syncing) return

  entry.dirty = false
  entry.syncing = true
  try {
    const result = await getCodeGraphWorker().request<CodeGraphOperationResult>(
      'codegraph/sync',
      { workingFolder: root },
      5 * 60_000
    )
    if (!isSuccess(result)) {
      console.warn('[CodeGraphSync] incremental sync did not complete', { root })
    }
  } catch (error) {
    console.warn('[CodeGraphSync] incremental sync failed', {
      root,
      error: error instanceof Error ? error.message : String(error)
    })
  } finally {
    entry.syncing = false
    if (entry.dirty) scheduleSync(root, entry)
  }
}

export function watchCodeGraphProject(root: string): void {
  if (!isEnabled()) return
  const normalizedRoot = normalizeRoot(root)
  if (!normalizedRoot || entries.has(normalizedRoot)) return
  if (entries.size >= MAX_AUTO_SYNC_PROJECTS) {
    console.warn('[CodeGraphSync] watcher limit reached', { limit: MAX_AUTO_SYNC_PROJECTS, root })
    return
  }

  const entry: SyncEntry = {
    watchers: new Map(),
    watcherSyncTimer: null,
    syncingWatchers: false,
    timer: null,
    syncing: false,
    dirty: false
  }
  entries.set(normalizedRoot, entry)
  void syncWatchers(normalizedRoot, entry)
}

export function unwatchCodeGraphProject(root: string): void {
  const normalizedRoot = normalizeRoot(root)
  if (!normalizedRoot) return
  const entry = entries.get(normalizedRoot)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  if (entry.watcherSyncTimer) clearTimeout(entry.watcherSyncTimer)
  for (const watcher of entry.watchers.values()) watcher.close()
  entry.watchers.clear()
  entries.delete(normalizedRoot)
}

export function observeCodeGraphOperation(method: string, params: unknown, result: unknown): void {
  if (!isSuccess(result) || !params || typeof params !== 'object') return
  const workingFolder = (params as { workingFolder?: unknown }).workingFolder
  if (typeof workingFolder !== 'string') return

  if (method === 'codegraph/index' || method === 'codegraph/sync') {
    watchCodeGraphProject(workingFolder)
  } else if (method === 'codegraph/remove-project') {
    unwatchCodeGraphProject(workingFolder)
  }
}

export async function startCodeGraphSync(): Promise<void> {
  if (started || !isEnabled()) return
  started = true
  try {
    const result = await getCodeGraphWorker().request<IndexedProjectList>(
      'codegraph/list-projects',
      {},
      10_000
    )
    if (!result.success) return
    for (const project of result.projects) {
      if (isIndexedProject(project)) watchCodeGraphProject(project.root)
    }
  } catch (error) {
    console.warn('[CodeGraphSync] unable to restore indexed projects', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export function stopCodeGraphSync(): void {
  started = false
  for (const root of [...entries.keys()]) {
    unwatchCodeGraphProject(root)
  }
}
