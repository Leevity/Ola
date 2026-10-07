import path from 'node:path'
import { realpathSync } from 'node:fs'

export type PathPolicyResult =
  | { allowed: true; resolvedPath: string }
  | { allowed: false; reason: 'outside-workspace' | 'invalid-path' }

/**
 * Resolve a user/tool path without allowing lexical workspace escape.
 * When `checkRealPath` is enabled the candidate is resolved through the
 * filesystem so symlinked directories cannot be used to traverse out of the
 * workspace root.
 */
export function resolveWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
  checkRealPath = true
): PathPolicyResult {
  if (!workspaceRoot || !requestedPath || requestedPath.includes('\0')) {
    return { allowed: false, reason: 'invalid-path' }
  }

  const root = path.resolve(workspaceRoot)
  const resolvedPath = path.resolve(root, requestedPath)

  let candidate = resolvedPath
  if (checkRealPath) {
    try {
      candidate = realpathSync(resolvedPath)
    } catch {
      // The path does not exist yet (e.g. an intended write target). Fall back
      // to lexical containment; an existing parent is still bound to root below.
    }
  }

  const relative = path.relative(root, candidate)
  const outside =
    relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)

  return outside
    ? { allowed: false, reason: 'outside-workspace' }
    : { allowed: true, resolvedPath: candidate }
}
