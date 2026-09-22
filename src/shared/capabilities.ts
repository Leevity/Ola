import {
  evaluateToolPermission,
  type PermissionEvaluation,
  type PermissionPolicy
} from './permission-policy'
import { evaluateCommandSyntax } from './security/command-policy'
import { resolveWorkspacePath } from './security/path-policy'

export type ToolCapabilityKind =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'shell.execute'
  | 'network.request'
  | 'browser.execute'
  | 'credential.readPlaintext'
  | 'credential.inject'
  | 'plugin.tool'
  | 'runtime.interact'

export interface ToolCapabilityRequest {
  kind: ToolCapabilityKind
  toolName: string
  input?: Record<string, unknown>
  effect: 'read' | 'write'
  workspaceRoot?: string
}

/**
 * Maps an Agent tool to the capability family that will own its resource checks.
 * This is deliberately conservative: unknown mutating tools become plugin.tool.
 */
export function capabilityForTool(toolName: string, effect: 'read' | 'write'): ToolCapabilityKind {
  if (toolName === 'Bash' || toolName === 'Shell' || toolName === 'Monitor' || toolName === 'PowerShell') {
    return 'shell.execute'
  }
  if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
    return 'filesystem.read'
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    return 'filesystem.write'
  }
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return 'network.request'
  if (toolName === 'BrowserExecuteScript') return 'browser.execute'
  if (toolName === 'CredentialFillPassword') return 'credential.inject'
  if (toolName === 'CredentialGetPlaintext') return 'credential.readPlaintext'
  return effect === 'read' ? 'runtime.interact' : 'plugin.tool'
}

/**
 * Central policy decision for mutating capabilities.
 * Resource-specific guards (path, URL, browser target and credential scope) are
 * intentionally layered after this decision and must fail closed.
 */
export function evaluateToolCapability(
  request: ToolCapabilityRequest,
  policy: PermissionPolicy | undefined
): PermissionEvaluation {
  if (request.kind === 'shell.execute' && typeof request.input?.command === 'string') {
    const commandResult = evaluateCommandSyntax(request.input.command)
    if (!commandResult.allowed) {
      return {
        decision: 'deny',
        rule: { id: 'capability-command-syntax', pattern: commandResult.reason, mode: 'wildcard', enabled: true }
      }
    }
  }

  if (
    request.workspaceRoot &&
    typeof request.input?.path === 'string' &&
    request.kind.startsWith('filesystem.')
  ) {
    const pathResult = resolveWorkspacePath(request.workspaceRoot, request.input.path)
    if (!pathResult.allowed) {
      return {
        decision: 'deny',
        rule: { id: 'capability-path-policy', pattern: pathResult.reason, mode: 'wildcard', enabled: true }
      }
    }
  }

  return evaluateToolPermission(request.toolName, request.input, policy)
}
