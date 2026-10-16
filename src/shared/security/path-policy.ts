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
  let comparisonRoot = root
  if (checkRealPath) {
    try {
      comparisonRoot = realpathSync(root)
    } catch {
      // A root that is being created can still be checked lexically.
    }
  }
  const resolvedPath = path.resolve(root, requestedPath)

  let comparisonCandidate = resolvedPath
  if (checkRealPath) {
    try {
      comparisonCandidate = realpathSync(resolvedPath)
    } catch {
      // Resolve the nearest existing parent so a not-yet-created path cannot
      // escape through a symlinked directory.
      const missingSegments: string[] = []
      let existingParent = resolvedPath
      while (true) {
        try {
          comparisonCandidate = path.join(realpathSync(existingParent), ...missingSegments)
          break
        } catch {
          const parent = path.dirname(existingParent)
          if (parent === existingParent) break
          missingSegments.unshift(path.basename(existingParent))
          existingParent = parent
        }
      }
    }
  }

  const relative = path.relative(comparisonRoot, comparisonCandidate)
  const outside =
    relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)

  return outside
    ? { allowed: false, reason: 'outside-workspace' }
    : { allowed: true, resolvedPath: comparisonCandidate }
}
