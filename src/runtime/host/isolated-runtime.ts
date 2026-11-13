import { RuntimeError, type RunSpec } from '../../shared/runtime/contracts'
import type { HostWorkspaceAuthorityResult } from '../../shared/runtime/host-protocol'
import { createAgentExecutor } from '../core/agent'
import type { RunExecutor } from '../scheduler/run-scheduler'
import {
  createHostProviderAdapter,
  createHostToolResolver,
  type HostProviderAdapter
} from './host-proxies'
import { startStandaloneRuntime, type RuntimeHostChannel } from './standalone'

/**
 * The isolated Agent runtime. It owns the journal, the scheduler and the agent
 * loop; Main owns credentials, desktop tools, hooks and approvals. Nothing here
 * imports Main, so a crash in this process cannot take the window with it.
 */
export async function startIsolatedRuntime(dataDirectory: string): Promise<{
  endpoint: string
  token: string
  stop: () => Promise<void>
}> {
  // The channel exists only once the service has been constructed, and no run
  // can be submitted before then: Main connects after the ready signal.
  let channel: RuntimeHostChannel | null = null
  const host = (): RuntimeHostChannel => {
    if (!channel) throw new RuntimeError('HOST_UNAVAILABLE')
    return channel
  }
  let provider: HostProviderAdapter | null = null
  let agent: RunExecutor | null = null
  const service = await startStandaloneRuntime({
    dataDirectory,
    allowHost: true,
    execute: async (run, context) => {
      const current = host()
      provider ??= createHostProviderAdapter(current)
      agent ??= createAgentExecutor(provider, createHostToolResolver(current))
      try {
        await agent(run, context)
      } finally {
        provider.forget(run.runId)
        void current.requestHost('tool.release', { runId: run.runId }).catch(() => undefined)
      }
    },
    authorize: async (run: RunSpec) => {
      await host().requestHost('authorize', { run }, 60_000)
    },
    authority: {
      workspaceIds: async () =>
        new Set(
          (await host().requestHost<HostWorkspaceAuthorityResult>('workspace.authority'))
            .workspaceIds
        )
    }
  })
  channel = service.hostChannel
  return { endpoint: service.endpoint, token: service.token, stop: service.stop }
}
