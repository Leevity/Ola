import { executeGit } from './git-executor'

export interface LocalGitStatusFile {
  path: string
  stagedStatus: string
  unstagedStatus: string
  originalPath?: string
}

export interface LocalGitStatusDetailed {
  branch: string
  upstream?: string
  ahead: number
  behind: number
  staged: LocalGitStatusFile[]
  unstaged: LocalGitStatusFile[]
  untracked: LocalGitStatusFile[]
  conflicted: LocalGitStatusFile[]
}

function header(
  input: string
): Pick<LocalGitStatusDetailed, 'branch' | 'upstream' | 'ahead' | 'behind'> {
  const match = /^##\s+([^.]+?)(?:\.\.\.([^\s]+))?(?:\s+\[([^\]]+)\])?$/.exec(input)
  const details = match?.[3]?.split(',').map((part) => part.trim()) ?? []
  const numberFor = (kind: 'ahead' | 'behind'): number => {
    const value = details
      .find((part) => part.startsWith(`${kind} `))
      ?.slice(kind.length)
      .trim()
    return value && /^\d+$/.test(value) ? Number(value) : 0
  }
  return {
    branch: match?.[1] || 'HEAD',
    ...(match?.[2] ? { upstream: match[2] } : {}),
    ahead: numberFor('ahead'),
    behind: numberFor('behind')
  }
}

/** Parses the legacy porcelain-v1 text format into the desktop status contract. */
export function parseLocalGitStatusDetailed(output: string): LocalGitStatusDetailed {
  const lines = output.split(/\r?\n/).filter(Boolean)
  const first = lines[0]?.startsWith('## ') ? lines.shift()! : '## HEAD'
  const result: LocalGitStatusDetailed = {
    ...header(first),
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: []
  }
  for (const line of lines) {
    if (line.length < 4) continue
    const stagedStatus = line[0]!
    const unstagedStatus = line[1]!
    const rawPath = line.slice(3)
    const renameParts = rawPath.split(' -> ')
    const item: LocalGitStatusFile = {
      path: renameParts.at(-1)!,
      stagedStatus,
      unstagedStatus,
      ...(renameParts.length > 1 ? { originalPath: renameParts[0] } : {})
    }
    if (stagedStatus === '?' && unstagedStatus === '?') {
      result.untracked.push(item)
    } else if (
      'UADRC'.includes(stagedStatus) &&
      'UADRC'.includes(unstagedStatus) &&
      (stagedStatus === 'U' || unstagedStatus === 'U')
    ) {
      result.conflicted.push(item)
    } else {
      if (stagedStatus !== ' ') result.staged.push(item)
      if (unstagedStatus !== ' ') result.unstaged.push(item)
    }
  }
  return result
}

export async function getLocalGitStatusDetailed(cwd: string): Promise<
  | { success: true; status: LocalGitStatusDetailed }
  | {
      success: false
      error: string
      errorType?: string
      exitCode: number
      stdout: string
      stderr: string
    }
> {
  const result = await executeGit(cwd, ['status', '--porcelain=v1', '-b'], {
    maxStdoutChars: 2 * 1024 * 1024
  })
  return result.success
    ? { success: true, status: parseLocalGitStatusDetailed(result.stdout) }
    : {
        success: false,
        error: result.stderr || 'Failed to get detailed status',
        ...(result.errorType ? { errorType: result.errorType } : {}),
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr
      }
}
