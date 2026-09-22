import { capabilityForTool, evaluateToolCapability } from '../../shared/capabilities'
import type { PermissionPolicy, PermissionPolicySnapshot } from '../../shared/permission-policy'
import type { RunSpec } from '../../shared/runtime/contracts'

export interface RuntimeToolAuthorizationInput {
  run: RunSpec
  tool: { name: string; effect: 'read' | 'write' }
  input: unknown
  permissionPolicy?: PermissionPolicySnapshot
}

/** Snapshot rules omit UI-only ids and `enabled`; every serialized rule is enabled by definition. */
function policyFromSnapshot(
  snapshot: PermissionPolicySnapshot | undefined
): PermissionPolicy | undefined {
  if (!snapshot) return undefined
  return {
    enabled: snapshot.enabled,
    whitelistedTools: snapshot.whitelistedTools,
    bashAllowRules: snapshot.bashAllowRules.map((rule, index) => ({
      ...rule,
      id: `allow-${index}`,
      enabled: true
    })),
    bashDenyRules: snapshot.bashDenyRules.map((rule, index) => ({
      ...rule,
      id: `deny-${index}`,
      enabled: true
    }))
  }
}

/**
 * Interactive (foreground) write/execute tools are gated by an explicit tool
 * snapshot rather than the Cron whitelist, but they must still clear the shared
 * Capability policy — command syntax, workspace-path containment and resource
 * binding. A `deny` decision here always wins; `allow`/`ask` keep the existing
 * snapshot-based behavior so no previously-allowed call regresses.
 */
function capabilityDenies(
  tool: { name: string; effect: 'read' | 'write' },
  safeInput: Record<string, unknown> | undefined,
  run: RunSpec,
  permissionPolicy: PermissionPolicySnapshot | undefined
): boolean {
  return (
    evaluateToolCapability(
      {
        kind: capabilityForTool(tool.name, tool.effect),
        toolName: tool.name,
        input: safeInput,
        effect: tool.effect,
        workspaceRoot: run.workingDirectory
      },
      policyFromSnapshot(permissionPolicy)
    ).decision === 'deny'
  )
}

/**
 * Foreground write/execute authorization: the tool must be in the run's explicit
 * snapshot AND must not be denied by the shared Capability policy.
 */
function interactiveMutationAuthorized(
  tool: { name: string; effect: 'read' | 'write' },
  safeInput: Record<string, unknown> | undefined,
  run: RunSpec,
  permissionPolicy: PermissionPolicySnapshot | undefined
): boolean {
  if (run.unattended) return false
  if (run.toolNames?.includes(tool.name) !== true) return false
  return !capabilityDenies(tool, safeInput, run, permissionPolicy)
}

/**
 * Background Cron work receives only persisted, explicit permission grants.
 * Other unattended runs do not inherit Cron authority merely by setting a
 * tool name, and interactive runs continue through the interaction protocol.
 */
export function isAuthorizedDesktopRuntimeTool({
  run,
  tool,
  input,
  permissionPolicy
}: RuntimeToolAuthorizationInput): boolean {
  // Read-only boundary: reads never mutate state, so they stay allowed for every
  // run type. This is the single audited place where a read bypasses the
  // Capability policy; any new read-effect tool inherits this bounded allowance
  // and must not widen it toward mutating effects.
  if (tool.effect === 'read') return true
  const safeInput =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined
  if (tool.name === 'Task' || tool.name === 'Agent') {
    return interactiveMutationAuthorized(tool, safeInput, run, permissionPolicy)
  }
  if (tool.name === 'AskUserQuestion' || tool.name === 'visualize_show_widget') {
    return !run.unattended && run.toolNames?.includes(tool.name) === true
  }
  if (tool.name === 'EnterPlanMode' || tool.name === 'ExitPlanMode') {
    return !run.unattended && run.toolNames?.includes(tool.name) === true
  }
  if (
    [
      'TeamCreate',
      'SendMessage',
      'TeamStatus',
      'TeamDelete',
      'TeamTaskCreate',
      'TeamTaskUpdate'
    ].includes(tool.name)
  ) {
    const backgroundTeamMember = run.taskId.startsWith('subagent:') && run.teamContext
    if (tool.name === 'TeamCreate' || tool.name === 'TeamDelete') return !run.unattended
    return (backgroundTeamMember || !run.unattended) && run.toolNames?.includes(tool.name) === true
  }
  if (tool.name === 'ImageGenerate') {
    return interactiveMutationAuthorized(tool, safeInput, run, permissionPolicy)
  }
  if (['Write', 'Edit'].includes(tool.name) && run.translationContext) {
    return interactiveMutationAuthorized(tool, safeInput, run, permissionPolicy)
  }
  if (tool.name === 'WriteOptimizedPrompts') {
    return interactiveMutationAuthorized(tool, safeInput, run, permissionPolicy)
  }
  if (
    tool.name === 'PluginSendMessage' ||
    tool.name === 'PluginReplyMessage' ||
    tool.name === 'FeishuSendImage' ||
    tool.name === 'FeishuSendFile' ||
    tool.name === 'FeishuSendAudio' ||
    tool.name === 'FeishuSendVideo' ||
    tool.name === 'FeishuAtMember' ||
    tool.name === 'FeishuSendUrgent' ||
    tool.name === 'WeixinSendImage' ||
    tool.name === 'WeixinSendFile' ||
    tool.name === 'FeishuBitableCreateRecords' ||
    tool.name === 'FeishuBitableUpdateRecords' ||
    tool.name === 'FeishuBitableDeleteRecords'
  ) {
    if (!run.unattended || !run.channelContext || !Array.isArray(run.toolNames)) return false
    const value =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : undefined
    const pluginId = typeof value?.plugin_id === 'string' ? value.plugin_id.trim() : ''
    const chatId = typeof value?.chat_id === 'string' ? value.chat_id.trim() : ''
    const messageId = typeof value?.message_id === 'string' ? value.message_id.trim() : ''
    return (
      run.toolNames.includes(tool.name) &&
      pluginId === run.channelContext.pluginId &&
      (tool.name.startsWith('FeishuBitable')
        ? pluginId === run.channelContext.pluginId
        : chatId === run.channelContext.chatId &&
          (tool.name !== 'PluginReplyMessage' && tool.name !== 'FeishuSendUrgent'
            ? true
            : messageId === run.channelContext.messageId))
    )
  }
  if (tool.name === 'create_goal' || tool.name === 'update_goal') {
    return !run.unattended && run.toolNames?.includes(tool.name) === true
  }
  const isCron = run.unattended && run.taskId.startsWith('cron:')
  const isBackgroundSubAgent = run.unattended && run.taskId.startsWith('subagent:')
  if (!isCron && !isBackgroundSubAgent) return false
  if (tool.name === 'Notify') return true
  return (
    evaluateToolCapability(
      {
        kind: capabilityForTool(tool.name, tool.effect),
        toolName: tool.name,
        input: safeInput,
        effect: tool.effect
      },
      policyFromSnapshot(permissionPolicy)
    ).decision === 'allow'
  )
}
