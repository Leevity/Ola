import {
  evaluateToolPermission,
  type PermissionPolicy,
  type PermissionPolicySnapshot
} from '../../shared/permission-policy'
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
  if (tool.effect === 'read') return true
  if (
    tool.name === 'PluginSendMessage' ||
    tool.name === 'PluginReplyMessage' ||
    tool.name === 'FeishuSendImage' ||
    tool.name === 'FeishuSendFile' ||
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
  const isCron = run.unattended && run.taskId.startsWith('cron:')
  if (!isCron) return false
  if (tool.name === 'Notify') return true
  const safeInput =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined
  return (
    evaluateToolPermission(tool.name, safeInput, policyFromSnapshot(permissionPolicy)).decision ===
    'allow'
  )
}
