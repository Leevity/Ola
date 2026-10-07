import { ProtocolAdapter } from '../../runtime/providers/protocol-adapter'
import {
  AccountGatewayTransport,
  LocalModelTransport,
  type ModelTransport
} from '../../runtime/providers/transport'
import { createAgentExecutor } from '../../runtime/core/agent'
import { ToolExecutor } from '../../runtime/tools/tool-executor'
import { createLocalReadFileTool } from '../../runtime/tools/local-read-file'
import { createLocalListDirectoryTool } from '../../runtime/tools/local-list-directory'
import { createLocalGitStatusTool } from '../../runtime/tools/local-git-status'
import { createLocalCreateFileTool } from '../../runtime/tools/local-create-file'
import { createLocalWriteFileTool } from '../../runtime/tools/local-write-file'
import { createLocalShellCommandTool } from '../../runtime/tools/local-shell-command'
import {
  createLegacyBashTool,
  createLegacyEditTool,
  createLegacyGlobTool,
  createLegacyGrepTool,
  createLegacyListDirectoryTool,
  createLegacyMonitorTool,
  createLegacyNotebookEditTool,
  createLegacyPowerShellTool,
  createLegacyReadTool,
  createLegacyWriteTool
} from '../../runtime/tools/workspace-tools'
import { selectExplicitTools } from '../../runtime/tools/explicit-tools'
import {
  createLocalFindFilesTool,
  createLocalGlobFilesTool
} from '../../runtime/tools/local-find-files'
import { createExtensionRuntimeTools } from '../extensions/extension-runtime-tools'
import { getExtensionService } from '../extensions/extension-runtime'
import {
  createLegacyWebFetchRuntimeTool,
  createLegacyWebSearchRuntimeTool,
  createWebFetchRuntimeTool,
  createWebSearchRuntimeTool
} from './web-runtime-tools'
import { createMcpRuntimeTools } from '../mcp/mcp-runtime-tools'
import { getActiveMcpManager } from '../ipc/mcp-handlers'
import { showSystemNotification } from '../ipc/notify-handlers'
import { createDesktopNotificationTool } from './desktop-notification-runtime-tool'
import { createTaskRuntimeTools } from './task-runtime-tools'
import { createGoalRuntimeTools } from './goal-runtime-tools'
import { createSubAgentRuntimeTool } from './sub-agent-runtime-tool'
import { AgentCatalog } from '../user-content/agent-catalog'
import { olaDataRoot } from '../lib/ola-data-root'
import { getBundledResourceDirCandidates } from '../resources/bundled-resources'
import { createSkillRuntimeTool } from './skill-runtime-tool'
import { createCronRuntimeTools } from './cron-runtime-tools'
import { createMemoryRuntimeTools } from './memory-runtime-tools'
import { createBrowserRuntimeTools } from './browser-runtime-tools'
import { createVideoRuntimeTool } from './video-runtime-tool'
import { createImageRuntimeTool } from './image-runtime-tool'
import { createTeamRuntimeTools } from './team-runtime-tools'
import { createPlanRuntimeTools } from './plan-runtime-tools'
import { createAskUserRuntimeTool } from './ask-user-runtime-tool'
import { createWidgetRuntimeTool } from './widget-runtime-tool'
import { createSshRuntimeTools } from './ssh-runtime-tools'
import { createTranslationRuntimeTools } from './translation-runtime-tools'
import { createPromptOptimizerRuntimeTool } from './prompt-optimizer-runtime-tool'
import {
  createChannelProviderReadRuntimeTools,
  createChannelProviderWriteRuntimeTools,
  createChannelReadRuntimeTools,
  createChannelWriteRuntimeTools
} from './channel-runtime-tools'
import { isAuthorizedDesktopRuntimeTool } from './runtime-tool-authorization'
import { readPermissionPolicySnapshot } from '../ipc/settings-handlers'
import { startStandaloneRuntime } from '../../runtime/host/standalone'
import { RuntimeClient } from '../../runtime/host/runtime-client'
import { RuntimeError, type RunSpec } from '../../shared/runtime/contracts'
import type { ModelProtocol } from '../../shared/runtime/model'
import {
  resolveMainProviderModel,
  resolveMainProviderSecret
} from '../providers/provider-main-store'
import { mainAccountGateway } from './account-gateway'
import {
  loadManagedModelResources,
  loadManagedWorkspaceIds,
  loadOfflineWorkspaceIds,
  loadOfflineWorkspaceExpiresAt
} from '../remote/account-client'
import { onRemoteAccountCleared, onWorkspaceDirectoryChanged } from '../remote/account-lifecycle'
import { resolveManagedResourceTarget } from './managed-resource-resolver'
import { OfflineWorkspaceExpiryMonitor } from './offline-workspace-expiry-monitor'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { businessWriteCanary } from '../db/business-write-canary'
import { assertScenarioToolPolicy, type ScenarioSessionPolicy } from './scenario-tool-policy'
import type { ScenarioPolicy } from '../../shared/scenario-policy'
import {
  clearDesktopRuntimeConnection,
  desktopRuntimeDescriptorPath,
  publishDesktopRuntimeConnection
} from '../../runtime/host/desktop-connection'

const protocols = new Set<ModelProtocol>([
  'openai-chat',
  'openai-responses',
  'anthropic',
  'gemini',
  'vertex-ai'
])

function protocol(value: unknown): ModelProtocol {
  if (typeof value === 'string' && protocols.has(value as ModelProtocol))
    return value as ModelProtocol
  throw new RuntimeError('MODEL_UNAVAILABLE')
}

async function approvedLocalWorkingDirectory(run: RunSpec): Promise<string> {
  if (!run.workingDirectory || !isAbsolute(run.workingDirectory))
    throw new RuntimeError('WORKING_DIRECTORY_REQUIRED')
  const directory = await realpath(run.workingDirectory).catch(() => {
    throw new RuntimeError('WORKING_DIRECTORY_UNAVAILABLE')
  })
  if (!(await stat(directory)).isDirectory())
    throw new RuntimeError('WORKING_DIRECTORY_UNAVAILABLE')
  return directory
}

async function enforceScenarioToolPolicy(run: RunSpec): Promise<ScenarioPolicy | null> {
  const writer = businessWriteCanary()
  if (!writer) throw new RuntimeError('TS_BUSINESS_REPOSITORY_UNAVAILABLE')
  const session = await writer.session<ScenarioSessionPolicy>(run.sessionId, run.workspaceId)
  await assertScenarioToolPolicy(run, session)
  return session?.scenario_policy ?? null
}

/**
 * Main owns this service and resolves credentials per request. The renderer
 * receives neither provider keys nor the local runtime connection token.
 * All desktop turns and tools are executed by this TypeScript runtime.
 */
export class DesktopRuntime {
  private service: Awaited<ReturnType<typeof startStandaloneRuntime>> | null = null
  private client: RuntimeClient | null = null
  private starting: Promise<void> | null = null
  private unsubscribeAccountEvents: Array<() => void> = []
  private expiryMonitor: OfflineWorkspaceExpiryMonitor | null = null

  constructor(private readonly connectionDescriptorPath = desktopRuntimeDescriptorPath()) {}

  get isAvailable(): boolean {
    return this.service !== null && this.client !== null
  }

  async start(dataDirectory: string): Promise<void> {
    if (this.service) return
    if (this.starting) return await this.starting
    this.starting = (async () => {
      const authorize = async (run: RunSpec): Promise<void> => {
        // Recheck at submission and again when a queued run starts. The socket
        // boundary alone cannot protect a team run after offline access expires.
        if (
          run.workspaceId !== 'local-personal' &&
          !(await loadOfflineWorkspaceIds()).has(run.workspaceId)
        )
          throw new RuntimeError('WORKSPACE_FORBIDDEN')
        if (run.environmentId !== 'local') throw new RuntimeError('MODEL_UNAVAILABLE')
        await enforceScenarioToolPolicy(run)
        if (run.modelSource.kind !== 'local') {
          if (!(await loadManagedWorkspaceIds()).has(run.workspaceId))
            throw new RuntimeError('MODEL_UNAVAILABLE')
          return
        }
        const resolved = resolveMainProviderModel(
          run.modelSource.providerId,
          run.modelSource.modelId
        )
        if (!resolved) throw new RuntimeError('MODEL_UNAVAILABLE')
        const apiKey = await resolveMainProviderSecret(
          run.modelSource.providerId,
          resolved.provider.apiKey
        )
        if (!apiKey && resolved.provider.requiresApiKey !== false)
          throw new RuntimeError('MODEL_UNAVAILABLE')
      }
      const local = new LocalModelTransport(async (run) => {
        await authorize(run)
        if (run.modelSource.kind !== 'local') throw new RuntimeError('MODEL_UNAVAILABLE')
        const resolved = resolveMainProviderModel(
          run.modelSource.providerId,
          run.modelSource.modelId
        )
        if (!resolved) throw new RuntimeError('MODEL_UNAVAILABLE')
        const websocketUrl =
          typeof resolved.model.websocketUrl === 'string'
            ? resolved.model.websocketUrl
            : typeof resolved.provider.websocketUrl === 'string'
              ? resolved.provider.websocketUrl
              : undefined
        const websocketMode =
          resolved.model.websocketMode === 'auto' || resolved.model.websocketMode === 'disabled'
            ? resolved.model.websocketMode
            : resolved.provider.websocketMode === 'auto' ||
                resolved.provider.websocketMode === 'disabled'
              ? resolved.provider.websocketMode
              : undefined
        const responsesSessionScope =
          typeof resolved.model.responsesSessionScope === 'string'
            ? resolved.model.responsesSessionScope
            : typeof resolved.provider.responsesSessionScope === 'string'
              ? resolved.provider.responsesSessionScope
              : undefined
        return {
          protocol: protocol(resolved.model.type ?? resolved.provider.type),
          model: run.modelSource.modelId,
          baseUrl: resolved.provider.baseUrl,
          apiKey: await resolveMainProviderSecret(
            run.modelSource.providerId,
            resolved.provider.apiKey
          ),
          options: run.modelOptions,
          ...(websocketUrl ? { websocketUrl } : {}),
          ...(websocketMode ? { websocketMode } : {}),
          ...(responsesSessionScope ? { responsesSessionScope } : {})
        }
      })
      const managed = new AccountGatewayTransport(async (run) => {
        if (run.modelSource.kind === 'local') throw new RuntimeError('MANAGED_MODEL_REQUIRED')
        const source = run.modelSource
        return resolveManagedResourceTarget({
          workspaceId: run.workspaceId,
          resourceId: source.resourceId,
          resources: await loadManagedModelResources(run.workspaceId)
        })
      }, mainAccountGateway)
      const transport: ModelTransport = {
        resolve: (run) =>
          run.modelSource.kind === 'local' ? local.resolve(run) : managed.resolve(run),
        request: (run, target, request, signal) =>
          run.modelSource.kind === 'local'
            ? local.request(run, target, request, signal)
            : managed.request(run, target, request, signal)
      }
      const adapter = new ProtocolAdapter(transport)
      const agentCatalog = new AgentCatalog({
        userDirectory: join(olaDataRoot(), 'agents'),
        bundledDirectoryCandidates: getBundledResourceDirCandidates('agents')
      })
      const tools = async (run: RunSpec): Promise<ToolExecutor> => {
        const scenarioPolicy = await enforceScenarioToolPolicy(run)
        const skillTool = scenarioPolicy ? null : await createSkillRuntimeTool()
        const subAgents = scenarioPolicy ? [] : await agentCatalog.list()
        const extensionTools = scenarioPolicy
          ? []
          : await createExtensionRuntimeTools(getExtensionService(), run.extensionIds)
        const mcpTools = scenarioPolicy
          ? []
          : (() => {
              try {
                const manager = getActiveMcpManager()
                return createMcpRuntimeTools(manager, manager.getConnectedServerIds(), (context) =>
                  join(
                    dataDirectory,
                    'mcp-results',
                    createHash('sha256').update(context.run.workspaceId).digest('hex')
                  )
                )
              } catch {
                return []
              }
            })()
        // A text-only run receives no filesystem capability unless its explicit
        // local root has been validated by Main for this exact run. Declarative
        // extensions are independent Main-owned capabilities and are selected
        // only from the run's project activation snapshot.
        const localTools =
          scenarioPolicy === 'materials-no-tools'
            ? Promise.resolve([])
            : run.sshConnectionId
              ? Promise.resolve(
                  createSshRuntimeTools(
                    run.sshConnectionId,
                    scenarioPolicy === 'ssh-read-only' ? run.workingDirectory : undefined
                  )
                )
              : run.workingDirectory
                ? (() => {
                    return approvedLocalWorkingDirectory(run).then((root) => [
                      createLocalReadFileTool(root),
                      createLocalListDirectoryTool(root),
                      createLocalFindFilesTool(root),
                      createLocalGlobFilesTool(root),
                      createLocalGitStatusTool(root),
                      createLocalCreateFileTool(root),
                      createLocalWriteFileTool(root),
                      createLocalShellCommandTool(root),
                      // Existing Agent/Cron prompts use these protocol names. Their
                      // implementations delegate to the same confined TS primitives.
                      createLegacyReadTool(root),
                      createLegacyListDirectoryTool(root),
                      createLegacyGlobTool(root),
                      createLegacyGrepTool(root),
                      createLegacyBashTool(root),
                      createLegacyMonitorTool(root),
                      createLegacyWriteTool(root),
                      createLegacyEditTool(root),
                      createLegacyNotebookEditTool(root),
                      ...(process.platform === 'win32' ? [createLegacyPowerShellTool(root)] : [])
                    ])
                  })()
                : Promise.resolve([])
        return new ToolExecutor(
          selectExplicitTools(
            [
              createWebFetchRuntimeTool(),
              createWebSearchRuntimeTool(),
              createLegacyWebFetchRuntimeTool(),
              createLegacyWebSearchRuntimeTool(),
              createDesktopNotificationTool(showSystemNotification),
              ...createTaskRuntimeTools(),
              ...createGoalRuntimeTools(),
              createSubAgentRuntimeTool('Task', subAgents),
              createSubAgentRuntimeTool('Agent', subAgents),
              ...(skillTool ? [skillTool] : []),
              ...createCronRuntimeTools(),
              ...createMemoryRuntimeTools(),
              ...createBrowserRuntimeTools(),
              createAskUserRuntimeTool(),
              createWidgetRuntimeTool(),
              ...(run.translationContext ? createTranslationRuntimeTools() : []),
              createPromptOptimizerRuntimeTool(),
              createImageRuntimeTool(),
              createVideoRuntimeTool(),
              ...createTeamRuntimeTools(),
              ...createPlanRuntimeTools(),
              ...createChannelReadRuntimeTools(),
              ...createChannelWriteRuntimeTools(),
              ...createChannelProviderReadRuntimeTools(),
              ...createChannelProviderWriteRuntimeTools(),
              ...mcpTools,
              ...(await localTools),
              ...extensionTools
            ],
            run.toolNames
          ),
          async (tool, input, context, call) => {
            if (
              isAuthorizedDesktopRuntimeTool({
                run,
                tool,
                input,
                permissionPolicy: readPermissionPolicySnapshot()
              })
            )
              return true
            if (run.unattended || !context.requestInteraction) return false
            const response = await context.requestInteraction({
              interactionId: `tool-approval:${call.id}`,
              kind: 'tool-approval',
              payload: { id: call.id, name: tool.name, input },
              version: '1'
            })
            return (
              !!response &&
              typeof response === 'object' &&
              (response as Record<string, unknown>).approved === true
            )
          }
        )
      }
      const service = await startStandaloneRuntime({
        dataDirectory,
        execute: createAgentExecutor(adapter, tools),
        authorize,
        authority: {
          workspaceIds: async () =>
            new Set(['local-personal', ...(await loadOfflineWorkspaceIds())])
        }
      })
      const client = new RuntimeClient()
      try {
        await client.connect(service.endpoint, service.token)
        await publishDesktopRuntimeConnection(
          { endpoint: service.endpoint, token: service.token },
          this.connectionDescriptorPath
        )
        const expiryMonitor = new OfflineWorkspaceExpiryMonitor(
          loadOfflineWorkspaceExpiresAt,
          loadOfflineWorkspaceIds,
          service.revokeUnavailableWorkspaces
        )
        this.expiryMonitor = expiryMonitor
        this.unsubscribeAccountEvents = [
          onRemoteAccountCleared(() => {
            expiryMonitor.stop()
            service.revokeUnavailableWorkspaces(new Set())
          }),
          onWorkspaceDirectoryChanged((ids) => {
            service.revokeUnavailableWorkspaces(ids)
            expiryMonitor.refreshSchedule()
          })
        ]
        service.revokeUnavailableWorkspaces(
          await loadOfflineWorkspaceIds().catch(() => new Set<string>())
        )
        expiryMonitor.refreshSchedule()
        this.service = service
        this.client = client
      } catch (error) {
        this.expiryMonitor?.stop()
        this.expiryMonitor = null
        for (const unsubscribe of this.unsubscribeAccountEvents.splice(0)) unsubscribe()
        client.close()
        await clearDesktopRuntimeConnection(service.token, this.connectionDescriptorPath).catch(
          (cleanupError) => {
            console.warn(
              '[TS Runtime] Failed to clear connection after startup failure',
              cleanupError
            )
          }
        )
        await service.stop().catch((cleanupError) => {
          console.warn('[TS Runtime] Failed to stop service after startup failure', cleanupError)
        })
        throw error
      }
    })()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  async stop(): Promise<void> {
    const starting = this.starting
    if (starting) await starting.catch(() => undefined)
    const service = this.service
    this.expiryMonitor?.stop()
    this.expiryMonitor = null
    for (const unsubscribe of this.unsubscribeAccountEvents.splice(0)) unsubscribe()
    this.service = null
    this.client?.close()
    this.client = null
    try {
      if (service) await clearDesktopRuntimeConnection(service.token, this.connectionDescriptorPath)
    } finally {
      await service?.stop()
    }
  }

  async recordExternalArtifact(
    spec: import('../../shared/runtime/contracts').RunSpec,
    artifact: { path: string; mediaType: string }
  ): Promise<void> {
    if (!this.service) throw new RuntimeError('RUNTIME_DISCONNECTED')
    await this.service.recordExternalArtifact(spec, artifact)
  }

  /** Routes Main-owned requests without exposing the socket endpoint or token. */
  async request<T>(method: string, params: unknown = {}): Promise<T> {
    if (!this.client) throw new RuntimeError('RUNTIME_DISCONNECTED')
    return await this.client.request<T>(method, params)
  }
}

export const desktopRuntime = new DesktopRuntime()
