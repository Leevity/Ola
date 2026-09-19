import { executeGit, type GitExecutionResult } from './git-executor'

const HISTORY_SEPARATOR = '\u0001'
const DEFAULT_HISTORY_LIMIT = 50
const MAX_HISTORY_LIMIT = 500
const DEFAULT_MAX_PATCH_CHARS = 96_000
const MAX_PATCH_CHARS = 512_000
const PATCH_TRUNCATED_SUFFIX = '\n\n[... patch truncated for size; more changes exist in index ...]'

export type LocalGitQuery =
  | 'get-head'
  | 'get-range-commits'
  | 'get-changed-files'
  | 'get-status'
  | 'get-line-summary'
  | 'get-file-diff'
  | 'get-file-diff-at-commit'
  | 'get-file-content-at-ref'
  | 'get-staged-diff-bundle'
  | 'get-commit-history'
  | 'list-branches'
  | 'get-file-history'

export interface GitCommitHistoryItem {
  hash: string
  shortHash: string
  author: string
  email: string
  date: string
  subject: string
}

export interface GitBranchItem {
  name: string
  fullName: string
  type: 'local' | 'remote'
  isCurrent: boolean
}

export interface LocalGitQueryOptions {
  base?: string
  head?: string
  filePath?: string
  staged?: boolean
  commitHash?: string
  ref?: string
  maxPatchChars?: number
  limit?: number
  skip?: number
}

export interface GitQueryResult {
  success: boolean
  commitId?: string
  commits?: string[]
  files?: string[]
  dirty?: boolean
  diff?: string
  isBinary?: boolean
  content?: string
  exists?: boolean
  stat?: string
  patch?: string
  empty?: boolean
  history?: GitCommitHistoryItem[]
  branches?: GitBranchItem[]
  current?: string
  added?: number
  deleted?: number
  binary?: number
  error?: string
  errorType?: string
  exitCode?: number
  stdout?: string
  stderr?: string
}

/**
 * Executes only the read-only Git queries used by the desktop protocol. This is
 * deliberately not a general Git command API: mutations continue through the
 * scheduler and permission boundary.
 */
export async function queryLocalGit(
  cwd: string,
  operation: LocalGitQuery,
  options: LocalGitQueryOptions | string = {}
): Promise<GitQueryResult> {
  const normalized = typeof options === 'string' ? legacyOptions(operation, options) : options
  const validationError = validateOptions(operation, normalized)
  if (validationError) return { success: false, error: validationError, errorType: 'VALIDATION' }

  switch (operation) {
    case 'get-head':
      return await getHead(cwd)
    case 'get-range-commits':
      return await getRangeCommits(cwd, range(normalized))
    case 'get-changed-files':
      return await getChangedFiles(cwd, range(normalized))
    case 'get-status':
      return await getStatus(cwd)
    case 'get-line-summary':
      return await getLineSummary(cwd)
    case 'get-file-diff':
      return await getFileDiff(cwd, normalized.filePath as string, Boolean(normalized.staged))
    case 'get-file-diff-at-commit':
      return await getFileDiffAtCommit(
        cwd,
        normalized.filePath as string,
        normalized.commitHash as string
      )
    case 'get-file-content-at-ref':
      return await getFileContentAtRef(cwd, normalized.filePath as string, normalized.ref as string)
    case 'get-staged-diff-bundle':
      return await getStagedDiffBundle(cwd, normalized.maxPatchChars)
    case 'get-commit-history':
      return await getHistory(cwd, normalized.limit, normalized.skip)
    case 'list-branches':
      return await listBranches(cwd)
    case 'get-file-history':
      return await getHistory(cwd, normalized.limit, normalized.skip, normalized.filePath as string)
  }
}

async function getHead(cwd: string): Promise<GitQueryResult> {
  const result = await run(cwd, ['rev-parse', 'HEAD'])
  return result.success
    ? { success: true, commitId: result.stdout.trim() }
    : failure(result, 'Failed to get HEAD')
}

async function getRangeCommits(cwd: string, revisionRange: string): Promise<GitQueryResult> {
  const result = await run(cwd, ['log', '--format=%H', revisionRange])
  return result.success
    ? { success: true, commits: lines(result.stdout) }
    : failure(result, 'Failed to get commit range')
}

async function getChangedFiles(cwd: string, revisionRange: string): Promise<GitQueryResult> {
  const result = await run(cwd, ['diff', '--name-only', revisionRange])
  return result.success
    ? { success: true, files: lines(result.stdout) }
    : failure(result, 'Failed to get changed files')
}

async function getStatus(cwd: string): Promise<GitQueryResult> {
  const result = await run(cwd, ['status', '--short'])
  if (!result.success) return failure(result, 'Failed to get git status')
  const files = lines(result.stdout)
  return { success: true, files, dirty: files.length > 0 }
}

async function getLineSummary(cwd: string): Promise<GitQueryResult> {
  const [unstaged, staged] = await Promise.all([
    run(cwd, ['diff', '--numstat', '--no-color']),
    run(cwd, ['diff', '--cached', '--numstat', '--no-color'])
  ])
  if (!unstaged.success) return failure(unstaged, 'Failed to get git line summary')
  if (!staged.success) return failure(staged, 'Failed to get git line summary')
  const first = numstat(unstaged.stdout)
  const second = numstat(staged.stdout)
  return {
    success: true,
    added: first.added + second.added,
    deleted: first.deleted + second.deleted,
    binary: first.binary + second.binary
  }
}

async function getFileDiff(
  cwd: string,
  filePath: string,
  staged: boolean
): Promise<GitQueryResult> {
  const args = staged
    ? ['diff', '--cached', '--no-color', '--', filePath]
    : ['diff', '--no-color', '--', filePath]
  const result = await run(cwd, args)
  return result.success
    ? { success: true, diff: result.stdout, isBinary: result.stdout.includes('Binary files') }
    : failure(result, 'Failed to get file diff')
}

async function getFileDiffAtCommit(
  cwd: string,
  filePath: string,
  commitHash: string
): Promise<GitQueryResult> {
  const result = await run(cwd, [
    'show',
    '--no-color',
    '--pretty=format:',
    '--no-notes',
    commitHash,
    '--',
    filePath
  ])
  return result.success
    ? { success: true, diff: result.stdout, isBinary: result.stdout.includes('Binary files') }
    : failure(result, 'Failed to get file diff at commit')
}

async function getFileContentAtRef(
  cwd: string,
  filePath: string,
  ref: string
): Promise<GitQueryResult> {
  const result = await run(cwd, ['show', `${ref}:${filePath}`])
  if (!result.success && isMissingPathAtRef(result.stderr)) {
    return { success: true, content: '', exists: false, isBinary: false }
  }
  return result.success
    ? {
        success: true,
        content: result.stdout,
        exists: true,
        isBinary: result.stdout.includes('\0')
      }
    : failure(result, 'Failed to read file content at ref')
}

async function getStagedDiffBundle(cwd: string, maxPatchChars?: number): Promise<GitQueryResult> {
  const maxPatch = clamp(maxPatchChars ?? DEFAULT_MAX_PATCH_CHARS, 1, MAX_PATCH_CHARS)
  const statResult = await run(cwd, ['diff', '--cached', '--stat'], 128 * 1024)
  if (!statResult.success) return failure(statResult, 'Failed to read staged diff stat')
  const stat = statResult.stdout.trim()
  if (!stat) return { success: true, stat: '', patch: '', empty: true }
  const patchResult = await run(cwd, ['diff', '--cached', '--no-color'], maxPatch + 1, true)
  if (!patchResult.success) return failure(patchResult, 'Failed to read staged patch')
  const patch =
    patchResult.stdoutTruncated || patchResult.stdout.length > maxPatch
      ? `${patchResult.stdout.slice(0, maxPatch)}${PATCH_TRUNCATED_SUFFIX}`
      : patchResult.stdout
  return { success: true, stat, patch, empty: false }
}

async function getHistory(
  cwd: string,
  limit?: number,
  skip?: number,
  filePath?: string
): Promise<GitQueryResult> {
  const format = ['%H', '%h', '%an', '%ae', '%ad', '%s'].join(HISTORY_SEPARATOR)
  const args = [
    'log',
    '--date=iso',
    `--pretty=format:${format}`,
    `--max-count=${clamp(limit ?? DEFAULT_HISTORY_LIMIT, 1, MAX_HISTORY_LIMIT)}`,
    `--skip=${Math.max(0, Math.trunc(skip ?? 0))}`,
    ...(filePath ? ['--', filePath] : [])
  ]
  const result = await run(cwd, args)
  return result.success
    ? { success: true, history: parseHistory(result.stdout) }
    : failure(result, `Failed to get ${filePath ? 'file ' : ''}commit history`)
}

async function listBranches(cwd: string): Promise<GitQueryResult> {
  const format = `%(refname)${HISTORY_SEPARATOR}%(refname:short)${HISTORY_SEPARATOR}%(HEAD)`
  const [local, remote] = await Promise.all([
    run(cwd, ['for-each-ref', '--format', format, 'refs/heads']),
    run(cwd, ['for-each-ref', '--format', format, 'refs/remotes'])
  ])
  if (!local.success) return failure(local, 'Failed to list local branches')
  if (!remote.success) return failure(remote, 'Failed to list remote branches')
  const branches = [
    ...parseBranches(local.stdout, 'local'),
    ...parseBranches(remote.stdout, 'remote')
  ]
  return { success: true, branches, current: branches.find((branch) => branch.isCurrent)?.name }
}

async function run(
  cwd: string,
  args: string[],
  maxStdoutChars = 2 * 1024 * 1024,
  allowTruncatedOutput = false
): Promise<GitExecutionResult> {
  return await executeGit(cwd, args, { maxStdoutChars, allowTruncatedOutput })
}

function legacyOptions(operation: LocalGitQuery, argument: string): LocalGitQueryOptions {
  if (operation === 'get-range-commits' || operation === 'get-changed-files') {
    const [base, head] = argument.split('..', 2)
    return { base, head }
  }
  if (operation === 'get-file-content-at-ref') {
    const separator = argument.indexOf(':')
    return separator > 0
      ? { ref: argument.slice(0, separator), filePath: argument.slice(separator + 1) }
      : {}
  }
  return {}
}

function validateOptions(
  operation: LocalGitQuery,
  options: LocalGitQueryOptions
): string | undefined {
  if (
    (operation === 'get-range-commits' || operation === 'get-changed-files') &&
    !isSafeRange(range(options))
  ) {
    return 'A valid git revision range is required'
  }
  if (
    [
      'get-file-diff',
      'get-file-diff-at-commit',
      'get-file-content-at-ref',
      'get-file-history'
    ].includes(operation) &&
    !isSafePath(options.filePath)
  ) {
    return 'A relative repository file path is required'
  }
  if (operation === 'get-file-diff-at-commit' && !isSafeRevision(options.commitHash)) {
    return 'A valid git commit reference is required'
  }
  if (operation === 'get-file-content-at-ref' && !isSafeRevision(options.ref)) {
    return 'A valid git reference is required'
  }
  return undefined
}

function range(options: LocalGitQueryOptions): string {
  return `${options.base ?? ''}..${options.head ?? 'HEAD'}`
}

function isSafeRange(value: string): boolean {
  const [base, head] = value.split('..', 2)
  return Boolean(base && head && isSafeRevision(base) && isSafeRevision(head))
}

function isSafeRevision(value: string | undefined): boolean {
  return Boolean(
    value && /^[A-Za-z0-9._~^@/:-]+$/.test(value) && !value.includes('..') && !value.startsWith('-')
  )
}

function isSafePath(value: string | undefined): boolean {
  return Boolean(
    value &&
    !value.includes('\0') &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !value.split('/').some((part) => part === '.' || part === '..' || !part)
  )
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).filter(Boolean)
}

function numstat(value: string): { added: number; deleted: number; binary: number } {
  return lines(value).reduce(
    (summary, row) => {
      const [added, deleted] = row.split('\t', 3)
      if (added === '-' || deleted === '-') summary.binary += 1
      else {
        summary.added += Number.parseInt(added, 10) || 0
        summary.deleted += Number.parseInt(deleted, 10) || 0
      }
      return summary
    },
    { added: 0, deleted: 0, binary: 0 }
  )
}

function parseHistory(value: string): GitCommitHistoryItem[] {
  return lines(value).flatMap((row) => {
    const [hash, shortHash, author, email, date, subject] = row.split(HISTORY_SEPARATOR, 6)
    return hash &&
      shortHash &&
      author !== undefined &&
      email !== undefined &&
      date !== undefined &&
      subject !== undefined
      ? [{ hash, shortHash, author, email, date, subject }]
      : []
  })
}

function parseBranches(value: string, type: GitBranchItem['type']): GitBranchItem[] {
  return lines(value).flatMap((row) => {
    const [fullName, name, current] = row.split(HISTORY_SEPARATOR, 3)
    return fullName && name ? [{ fullName, name, type, isCurrent: current === '*' }] : []
  })
}

function isMissingPathAtRef(stderr: string): boolean {
  const normalized = stderr.toLowerCase()
  return (
    normalized.includes('does not exist') ||
    normalized.includes('exists on disk, but not in') ||
    normalized.includes('invalid object name')
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function failure(result: GitExecutionResult, fallback: string): GitQueryResult {
  return {
    success: false,
    error: result.stderr.trim() || fallback,
    ...(result.errorType ? { errorType: result.errorType } : {}),
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr
  }
}
