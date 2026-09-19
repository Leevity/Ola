import type { CronAgentRunOptions } from './cron-agent-background'

/**
 * The TS runtime is selected only when its host capabilities match the saved
 * job exactly. Older jobs, SSH execution and channel delivery stay on the
 * legacy engine until their dedicated adapters are migrated.
 */
export function canRunCronInTsRuntime(
  options: Pick<
    CronAgentRunOptions,
    'agentId' | 'modelSource' | 'sshConnectionId' | 'pluginId' | 'pluginChatId'
  >,
  runtimeAvailable: boolean
): boolean {
  return (
    runtimeAvailable &&
    options.modelSource !== null &&
    options.modelSource !== undefined &&
    !options.sshConnectionId &&
    !options.pluginId &&
    !options.pluginChatId &&
    (!options.agentId || options.agentId === 'CronAgent')
  )
}
