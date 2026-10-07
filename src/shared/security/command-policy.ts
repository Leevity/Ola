export type CommandPolicyResult =
  | { allowed: true }
  | { allowed: false; reason: 'empty-command' | 'blocked-token' }

const BLOCKED_TOKENS = ['&&', '||', ';', '\n', '\r', ' >', '>>', '<', '|']

/** Conservative lexical guard; the existing approval and allow/deny policy remains authoritative. */
export function evaluateCommandSyntax(command: string): CommandPolicyResult {
  const normalized = command.trim()
  if (!normalized) return { allowed: false, reason: 'empty-command' }
  if (BLOCKED_TOKENS.some((token) => normalized.includes(token))) {
    return { allowed: false, reason: 'blocked-token' }
  }
  return { allowed: true }
}
