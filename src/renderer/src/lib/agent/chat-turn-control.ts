import { workspaceModelProviders } from '@renderer/lib/workspace-models'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'
import { isOlaManagedProviderId } from '@renderer/lib/workspace-context'
import { nanoid } from 'nanoid'
import { toast } from 'sonner'
import i18n from '@renderer/locales'
import { useChatStore, type Session } from '@renderer/stores/chat-store'
import { resolveReasoningEffortForModel, useSettingsStore } from '@renderer/stores/settings-store'
import {
  modelSupportsComputerUse,
  modelSupportsVision,
  useProviderStore
} from '@renderer/stores/provider-store'
import { useAgentStore } from '@renderer/stores/agent-store'
import {
  getSessionAbortController,
  hasSessionAbortController
} from '@renderer/lib/agent/session-run-lifecycle'
import { useUIStore } from '@renderer/stores/ui-store'
import { useSshStore } from '@renderer/stores/ssh-store'
import {
  decodeStructuredToolResult,
  isStructuredToolErrorText
} from '@renderer/lib/tools/tool-result-format'
import { parseSubAgentMeta, TASK_TOOL_NAME } from '@renderer/lib/agent/sub-agents/create-tool'
import { abortAllTeammates } from '@renderer/lib/agent/teams/team-native-control'
import { teamEvents } from '@renderer/lib/agent/teams/events'
import { useTeamStore, type ActiveTeam } from '@renderer/stores/team-store'
import { ipcClient } from '@renderer/lib/ipc/ipc-client'
import { IPC } from '@renderer/lib/ipc/channels'
import { clearPendingQuestions } from '@renderer/lib/tools/ask-user-tool'
import type { HookEvent, HookOutput } from '../../../../shared/hooks/types'
import { usePlanStore, type Plan } from '@renderer/stores/plan-store'
import { useTaskStore } from '@renderer/stores/task-store'
import { useGoalStore, type SessionGoal } from '@renderer/stores/goal-store'
import { resolveSessionModelSelection } from '@renderer/lib/session-model-resolution'
import type {
  UnifiedMessage,
  ProviderConfig,
  ContentBlock,
  AIModelConfig,
  ToolDefinition,
  ToolResultContent,
  SelectedFileReadItemMeta,
  SelectedFileReadsMeta,
  SelectedFileReference
} from '@renderer/lib/api/types'
import {
  extractEditableUserMessageDraft,
  imageAttachmentToContentBlock,
  isEditableUserMessage,
  type EditableUserMessageDraft,
  type ImageAttachment
} from '@renderer/lib/image-attachments'
import { loadCommandSnapshot } from '@renderer/lib/commands/command-loader'
import {
  buildSlashCommandUserText,
  parseSlashCommandInput,
  serializeSystemCommand,
  type SystemCommandSnapshot
} from '@renderer/lib/commands/system-command'
import { parseSelectFileText } from '@renderer/lib/select-file-tags'
import { type ToolCallState } from '@renderer/lib/agent/types'
import { estimateContextTokensForRequest } from '@renderer/lib/agent/context-usage'
import { flushRuntimeForegroundMutations } from '@renderer/lib/agent/session-runtime-router'
import { emitSessionRuntimeSync } from '@renderer/lib/session-runtime-sync'
import {
  emitSessionControlSync,
  installSessionControlSyncListener,
  type SessionControlSyncEvent
} from '@renderer/lib/session-control-sync'
import { useChannelStore } from '@renderer/stores/channel-store'
import { useRuntimeProjectionStore } from '@renderer/stores/runtime-projection-store'
import { confirm } from '@renderer/components/ui/confirm-dialog'
import { useMcpStore } from '@renderer/stores/mcp-store'
import {
  registerMcpTools,
  unregisterMcpTools,
  isMcpToolsRegistered,
  registerMcpResources
} from '@renderer/lib/mcp/mcp-tools'
import { selectAutoModel } from '@renderer/lib/api/auto-model-selector'
import { ensureDefaultChatWorkingFolder } from '@renderer/lib/chat-working-folder'
import {
  escapeGoalXmlText,
  goalStatusLabel,
  validateGoalObjective
} from '@renderer/lib/agent/goal-context'
import {
  getTailToolExecutionState,
  type TailToolExecutionState
} from '@renderer/components/chat/transcript-utils'
import type { AutoModelSelectionStatus } from '@renderer/stores/ui-store'
import {
  clearDispatchingSessionMessage,
  dequeuePendingSessionMessage,
  flushPendingSessionQueue,
  getQueuedSessionMessages,
  hasPendingSessionMessages,
  isPendingSessionDispatchPaused,
  markQueuedSessionMessageDispatching,
  persistCurrentPendingSessionQueue,
  replaceSessionPendingMessages,
  setPendingSessionDispatchPaused,
  type QueuedSessionMessage
} from '@renderer/hooks/use-pending-session-queue'
import type { MessageSource, SendMessageOptions } from '@renderer/hooks/send-message-options'

/** Per-session abort controllers — module-level so concurrent sessions don't overwrite each other */
export const hookStartedSessions = new Set<string>()
export const stopAfterCurrentRequestSessions = new Set<string>()
export const continuingToolExecutionSessions = new Set<string>()
const pendingGoalContinuationSessions = new Set<string>()
const scheduledGoalContinuationSessions = new Set<string>()
export const RUNTIME_CONTEXT_SOURCE_MAX_MESSAGES = 160
export const CONTINUE_TOOL_TAIL_WINDOW_MESSAGES = 120

export function requestLikelyRequiresExecute(input: string): boolean {
  const normalized = input.trim().toLowerCase()
  if (!normalized) return false
  if (
    /\b(how (?:do|can|to)|explain|what is|show me how)\b|(?:怎么|如何|是什么|解释一下)/i.test(
      normalized
    )
  ) {
    return false
  }
  return /\b(create|write|edit|modify|delete|remove|rename|move|copy|run|execute|install|uninstall|build|test|commit|push|pull|merge|deploy|publish|send|post|order|upload|download)\b|(?:帮我|请|直接).*(?:创建|新建|写入|修改|编辑|删除|移除|重命名|移动|复制|运行|执行|安装|卸载|构建|测试|提交|推送|拉取|合并|部署|发布|发送|下单|上传|下载)/i.test(
    normalized
  )
}

export function refreshTsRuntimePlan(sessionId: string, toolName: string, status: string): void {
  if (status !== 'completed' || !['EnterPlanMode', 'ExitPlanMode'].includes(toolName)) return
  void usePlanStore
    .getState()
    .loadPlanForSession(sessionId, true)
    .then((plan) => {
      if (!plan) return
      usePlanStore.getState().setActivePlan(plan.id)
      if (toolName === 'EnterPlanMode') useUIStore.getState().enterPlanMode(sessionId)
      else useUIStore.getState().exitPlanMode(sessionId)
    })
}
installSessionControlSyncListener((event) => {
  applySessionControlSyncEvent(event)
})

// Clean up module-level Maps when sessions are deleted to prevent unbounded growth.
let knownSessionIds: Set<string> | null = null
useChatStore.subscribe((state) => {
  const currentIds = new Set(state.sessions.map((s) => s.id))
  if (knownSessionIds) {
    for (const id of knownSessionIds) {
      if (!currentIds.has(id)) {
        hookStartedSessions.delete(id)
      }
    }
  }
  knownSessionIds = currentIds
})
export async function emitHooks(
  event: HookEvent,
  invocation: {
    sessionId: string
    projectPath?: string
    toolName?: string
    toolInput?: Record<string, unknown>
    toolResult?: unknown
    prompt?: string
    cancellationKey?: string
  }
): Promise<HookOutput[]> {
  if (
    useChatStore
      .getState()
      .sessions.some((session) => session.id === invocation.sessionId && session.scenarioPolicy)
  )
    return []
  return (await ipcClient.invoke('hooks:emit', { event, invocation })) as HookOutput[]
}

function addMessageWithSync(sessionId: string, message: UnifiedMessage): void {
  useChatStore.getState().addMessage(sessionId, message)
  emitSessionRuntimeSync({ kind: 'add_message', sessionId, message })
}

export function buildUserMessageContent(
  text: string,
  images?: ImageAttachment[],
  prefixBlocks: Array<Extract<ContentBlock, { type: 'text' }>> = []
): UnifiedMessage['content'] {
  const blocks = [...prefixBlocks]
  if (text) blocks.push({ type: 'text', text })

  if (images && images.length > 0) {
    return [...blocks, ...images.map(imageAttachmentToContentBlock)]
  }

  if (blocks.length === 1 && blocks[0]) return blocks[0].text
  return blocks
}

export function setStreamingMessageIdWithSync(sessionId: string, messageId: string | null): void {
  if (messageId === null) {
    flushRuntimeForegroundMutations()
  }
  useChatStore.getState().setStreamingMessageId(sessionId, messageId)
  emitSessionRuntimeSync({ kind: 'set_streaming_message', sessionId, messageId })
}

export function setGeneratingImageWithSync(messageId: string, generating: boolean): void {
  const occurredAt = Date.now()
  useChatStore.getState().setGeneratingImage(messageId, generating, occurredAt)
  emitSessionRuntimeSync({ kind: 'set_generating_image', messageId, generating, occurredAt })
}

export function setGeneratingImagePreviewWithSync(
  messageId: string,
  preview: ContentBlock | null
): void {
  useChatStore
    .getState()
    .setGeneratingImagePreview(messageId, preview?.type === 'image' ? preview : null)
  emitSessionRuntimeSync({
    kind: 'set_generating_image_preview',
    messageId,
    preview
  })
}

type SshRequestPreflightFailure = {
  title: string
  description: string
  code: string
}

export async function ensureSshSessionReadyForRequest(
  sessionId: string
): Promise<SshRequestPreflightFailure | null> {
  const session = useChatStore.getState().sessions.find((item) => item.id === sessionId)
  const connectionId = session?.sshConnectionId?.trim()
  if (!connectionId) return null

  const sshStore = useSshStore.getState()
  const connectionName =
    sshStore.connections.find((connection) => connection.id === connectionId)?.name ?? connectionId

  const connectResult = await sshStore.connectSftpConnection(connectionId)
  if (connectResult.error) {
    return {
      title: 'SSH connection unavailable',
      description: connectResult.error || connectionName,
      code: 'ssh_connection_unavailable'
    }
  }

  const workingFolder = session?.workingFolder?.trim()
  if (!workingFolder) return null

  const mkdirResult = (await ipcClient.invoke(IPC.SSH_FS_MKDIR, {
    connectionId,
    path: workingFolder
  })) as { error?: string }
  if (mkdirResult?.error) {
    return {
      title: 'SSH working directory unavailable',
      description: mkdirResult.error,
      code: 'ssh_working_directory_unavailable'
    }
  }

  return null
}

export function extractPluginChatId(externalChatId?: string): string | undefined {
  if (!externalChatId) return undefined
  const match = externalChatId.match(/^plugin:[^:]+:chat:(.+?)(?::message:.+)?$/)
  if (!match?.[1]) return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

export function resolveSessionWorkingFolder(
  session?: { projectId?: string; workingFolder?: string | null } | null,
  fallbackWorkingFolder?: string | null
): string | undefined {
  const direct = session?.workingFolder?.trim() || fallbackWorkingFolder?.trim()
  if (direct) return direct
  const projectId = session?.projectId
  if (!projectId) return undefined
  const project = useChatStore.getState().projects.find((item) => item.id === projectId)
  return project?.workingFolder?.trim() || undefined
}

export async function ensureChatSessionWorkingFolder(sessionId: string): Promise<void> {
  const chatStore = useChatStore.getState()
  const session = chatStore.sessions.find((item) => item.id === sessionId)
  if (
    !session ||
    session.mode !== 'chat' ||
    session.sshConnectionId ||
    session.scenarioPolicy === 'materials-no-tools'
  )
    return
  if (session.workingFolder?.trim()) return

  const folder = await ensureDefaultChatWorkingFolder()
  if (folder) {
    chatStore.setWorkingFolder(sessionId, folder)
  }
}

export function resolveActiveMcpContext(projectId?: string | null): {
  activeMcps: ReturnType<ReturnType<typeof useMcpStore.getState>['getActiveMcps']>
  activeMcpTools: ReturnType<ReturnType<typeof useMcpStore.getState>['getActiveMcpTools']>
} {
  const mcpStore = useMcpStore.getState()
  const activeMcps = mcpStore.getActiveMcps(projectId)
  const activeMcpTools = mcpStore.getActiveMcpTools(projectId)
  const activeMcpResources = mcpStore.getActiveMcpResources(projectId)

  if (activeMcps.length > 0) {
    const hasTools = Object.keys(activeMcpTools).length > 0
    const hasResources = Object.keys(activeMcpResources).length > 0
    if (hasTools) {
      registerMcpTools(activeMcps, activeMcpTools)
    }
    if (hasResources) {
      registerMcpResources(activeMcps, activeMcpResources)
    }
  } else if (isMcpToolsRegistered()) {
    unregisterMcpTools()
  }

  return { activeMcps, activeMcpTools }
}

export function summarizeActiveTeamForPromptCache(activeTeam: ActiveTeam | null | undefined): {
  name: string
  permissionMode?: string
  defaultBackend?: string
  members: string[]
} | null {
  if (!activeTeam) return null
  return {
    name: activeTeam.name,
    permissionMode: activeTeam.permissionMode,
    defaultBackend: activeTeam.defaultBackend,
    members: activeTeam.members.map((member) => member.name)
  }
}

const SELECTED_FILE_READ_MAX_LINES = 1_000

export const QUEUED_MESSAGE_SYSTEM_REMIND = `<system-reminder>
A new user message was queued while you were still processing the previous request.
This message was inserted after that run finished.
Treat the following user query as the latest instruction and respond to it directly.
</system-reminder>`

export function buildGoalMessageSystemReminder(objective: string): string {
  return (
    `<system-reminder>\n` +
    `The user has started a goal pursuit. Treat the current user message as the goal objective and continue working toward it across turns until the goal is completed, paused, or cleared.\n` +
    `Goal objective:\n${escapeGoalXmlText(objective)}\n` +
    `</system-reminder>`
  )
}

function normalizeFilePath(value: string): string {
  return value.replace(/\\/g, '/').trim()
}

function normalizeFilePathKey(value: string): string {
  return normalizeFilePath(value).toLowerCase()
}

function isAbsoluteFilePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

function getBaseNameFromPath(value: string): string {
  const normalized = normalizeFilePath(value)
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] || normalized || 'file'
}

function resolvePreviewPath(sendPath: string, workingFolder?: string): string {
  const normalized = normalizeFilePath(sendPath)
  if (!normalized || isAbsoluteFilePath(normalized) || !workingFolder) return normalized
  return `${normalizeFilePath(workingFolder).replace(/\/+$/, '')}/${normalized.replace(/^\/+/, '')}`
}

function sanitizeSelectedFileReference(value: SelectedFileReference): SelectedFileReference | null {
  const sendPath = normalizeFilePath(value.sendPath)
  const previewPath = normalizeFilePath(value.previewPath || value.originalPath || sendPath)
  const originalPath = normalizeFilePath(value.originalPath || previewPath || sendPath)
  const name = value.name.trim() || getBaseNameFromPath(sendPath || previewPath || originalPath)

  if (!sendPath && !previewPath && !originalPath) return null

  return {
    id: value.id,
    name,
    originalPath,
    sendPath,
    previewPath,
    isWorkspaceFile: Boolean(value.isWorkspaceFile)
  }
}

function resolveSelectedFileReferences(
  text: string,
  options: SendMessageOptions | undefined,
  session: Session | undefined
): SelectedFileReference[] {
  const explicit = (options?.selectedFileReferences ?? [])
    .map(sanitizeSelectedFileReference)
    .filter((file): file is SelectedFileReference => Boolean(file))
  if (explicit.length > 0) return explicit

  const workingFolder = session?.workingFolder
  const byPath = new Map<string, SelectedFileReference>()
  for (const segment of parseSelectFileText(text)) {
    if (segment.type !== 'file') continue
    const sendPath = normalizeFilePath(segment.text)
    if (!sendPath) continue
    const previewPath = resolvePreviewPath(sendPath, workingFolder)
    const key = normalizeFilePathKey(previewPath || sendPath)
    if (byPath.has(key)) continue
    byPath.set(key, {
      id: `file-${byPath.size + 1}`,
      name: getBaseNameFromPath(sendPath),
      originalPath: previewPath || sendPath,
      sendPath,
      previewPath: previewPath || sendPath,
      isWorkspaceFile: !isAbsoluteFilePath(sendPath) && Boolean(workingFolder)
    })
  }

  return Array.from(byPath.values())
}

type ReadTextFileLinesResult = {
  content?: string
  name?: string
  path?: string
  lineCount?: number
  maxLines?: number
  truncated?: boolean
  error?: string
}

function formatReadError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error || 'Failed to read file')
}

function sanitizeSelectedFileContextContent(content: string): string {
  return content.replace(/<\/system-reminder>/gi, '<\\/system-reminder>')
}

export async function buildSelectedFileReadContext(args: {
  text: string
  options?: SendMessageOptions
  session?: Session
}): Promise<{ meta?: SelectedFileReadsMeta; contextText?: string }> {
  const files = resolveSelectedFileReferences(args.text, args.options, args.session)
  if (files.length === 0) return {}

  const metaFiles: SelectedFileReadItemMeta[] = []
  const contextSections: string[] = []
  const sshConnectionId = args.session?.sshConnectionId

  for (const file of files) {
    const displayPath = file.sendPath || file.previewPath || file.originalPath
    const readPath = file.previewPath || file.originalPath || file.sendPath
    const baseMeta: SelectedFileReadItemMeta = {
      id: file.id,
      name: file.name || getBaseNameFromPath(displayPath),
      path: displayPath,
      readPath,
      lineCount: 0,
      maxLines: SELECTED_FILE_READ_MAX_LINES,
      truncated: false
    }

    try {
      const result = (await ipcClient.invoke(
        sshConnectionId ? IPC.SSH_FS_READ_TEXT_FILE_LINES : IPC.FS_READ_TEXT_FILE_LINES,
        sshConnectionId
          ? {
              connectionId: sshConnectionId,
              path: readPath,
              maxLines: SELECTED_FILE_READ_MAX_LINES
            }
          : { path: readPath, maxLines: SELECTED_FILE_READ_MAX_LINES }
      )) as ReadTextFileLinesResult

      if (result?.error) {
        metaFiles.push({ ...baseMeta, error: result.error })
        continue
      }

      const content = typeof result.content === 'string' ? result.content : ''
      const lineCount =
        typeof result.lineCount === 'number'
          ? result.lineCount
          : content
            ? content.split('\n').length
            : 0
      const maxLines =
        typeof result.maxLines === 'number' ? result.maxLines : SELECTED_FILE_READ_MAX_LINES
      const truncated = Boolean(result.truncated)
      const name = result.name || baseMeta.name
      const resultPath = result.path || readPath

      metaFiles.push({
        ...baseMeta,
        name,
        readPath: resultPath,
        lineCount,
        maxLines,
        truncated
      })

      contextSections.push(
        [
          `## ${displayPath}`,
          sanitizeSelectedFileContextContent(content),
          truncated ? `[Only the first ${lineCount} lines were read.]` : ''
        ]
          .filter(Boolean)
          .join('\n')
      )
    } catch (error) {
      metaFiles.push({ ...baseMeta, error: formatReadError(error) })
    }
  }

  const meta: SelectedFileReadsMeta = {
    maxLines: SELECTED_FILE_READ_MAX_LINES,
    files: metaFiles
  }

  const contextText =
    contextSections.length > 0
      ? [
          '<system-reminder>',
          'The user selected file references in this message. The application read the following file contents directly before sending. Use this as user-provided context.',
          '<selected_files>',
          ...contextSections,
          '</selected_files>',
          '</system-reminder>'
        ].join('\n')
      : undefined

  return { meta, contextText }
}

export function getTaskProgressSnapshot(sessionId: string): string {
  const tasks = useTaskStore.getState().getTasksBySession(sessionId)
  const pending = tasks.filter((task) => task.status === 'pending').length
  const inProgress = tasks.filter((task) => task.status === 'in_progress').length
  const completed = tasks.filter((task) => task.status === 'completed').length
  return `${tasks.length}:${pending}:${inProgress}:${completed}`
}

export function shouldClearCompletedSessionTasks(sessionId: string): boolean {
  const tasks = useTaskStore.getState().getTasksBySession(sessionId)
  return tasks.length > 0 && tasks.every((task) => task.status === 'completed')
}

function extractMessagePlainText(message?: UnifiedMessage): string {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim()
}

function extractToolResultText(content?: ToolResultContent): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (block): block is Extract<ToolResultContent[number], { type: 'text' }> =>
        block.type === 'text'
    )
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function extractApiErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null

  const record = payload as Record<string, unknown>
  if (typeof record.message === 'string' && record.message.trim()) {
    return record.message.trim()
  }

  const error = record.error
  if (typeof error === 'string' && error.trim()) {
    return error.trim()
  }

  if (error && typeof error === 'object') {
    const nestedError = error as Record<string, unknown>
    if (typeof nestedError.message === 'string' && nestedError.message.trim()) {
      return nestedError.message.trim()
    }
    if (typeof nestedError.error === 'string' && nestedError.error.trim()) {
      return nestedError.error.trim()
    }
  }

  return null
}

function parseJsonErrorCandidate(candidate: string): unknown | null {
  const trimmed = candidate.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null

  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

export function normalizeContinuationErrorMessage(message: string): string {
  const trimmed = message.trim()
  if (!trimmed) return 'Tool continuation failed'

  const withoutHttpPrefix = trimmed.replace(/^HTTP\s+\d{3}:\s*/i, '').trim()
  const withoutProviderPrefix = withoutHttpPrefix
    .replace(/^(?:OpenAI response error|Response error|API error):\s*/i, '')
    .trim()

  for (const candidate of [withoutProviderPrefix, withoutHttpPrefix, trimmed]) {
    const parsed = parseJsonErrorCandidate(candidate)
    const extracted = extractApiErrorMessage(parsed)
    if (!extracted) continue
    if (/No tool output found for function call/i.test(extracted)) {
      return 'Model requests previous function call tool output, but no matching result in current session'
    }
    return extracted
  }

  if (/No tool output found for function call/i.test(withoutProviderPrefix)) {
    return 'Model requests previous function call tool output, but no matching result in current session'
  }

  return withoutProviderPrefix || withoutHttpPrefix || trimmed
}

export function shouldSuppressTransientRuntimeError(message: string | null | undefined): boolean {
  const normalized = message?.trim()
  if (!normalized) return false

  return (
    /CancellationTokenSource has been disposed/i.test(normalized) ||
    (/Cannot access a disposed object\./i.test(normalized) &&
      /CancellationTokenSource/i.test(normalized))
  )
}

export function reconcileSubAgentCompletionFromTaskToolCall(
  sessionId: string,
  toolCall: ToolCallState
): void {
  if (toolCall.name !== TASK_TOOL_NAME || toolCall.input.run_in_background === true) return

  const agentStore = useAgentStore.getState()
  const tracked =
    agentStore.activeSubAgents[toolCall.id] ?? agentStore.completedSubAgents[toolCall.id]
  if (!tracked) return

  const rawOutput = extractToolResultText(toolCall.output)
  if (!rawOutput.trim() && toolCall.status !== 'error' && !toolCall.error) return

  const { meta, text } = parseSubAgentMeta(rawOutput)
  const payloadText = text.trim() || rawOutput.trim()
  const decoded = payloadText ? decodeStructuredToolResult(payloadText) : null
  const structured = decoded && !Array.isArray(decoded) ? decoded : null
  const error =
    toolCall.error ??
    (structured && typeof structured.error === 'string' ? structured.error : undefined)
  const structuredResult =
    structured && typeof structured.result === 'string' ? structured.result : ''
  const report =
    error && !structuredResult ? '' : structuredResult || (structured ? '' : payloadText)
  const subAgentName = String(toolCall.input.subagent_type ?? tracked.displayName ?? tracked.name)

  agentStore.handleSubAgentEvent(
    {
      type: 'sub_agent_report_update',
      subAgentName,
      toolUseId: toolCall.id,
      report,
      status: report.trim() ? 'submitted' : 'missing'
    },
    sessionId
  )

  agentStore.handleSubAgentEvent(
    {
      type: 'sub_agent_end',
      subAgentName,
      toolUseId: toolCall.id,
      result: {
        success: !error,
        output: report,
        reportSubmitted: !!report.trim(),
        toolCallCount: meta?.toolCalls.length ?? tracked.toolCalls.length,
        iterations: meta?.iterations ?? tracked.iteration,
        ...(meta?.usage ? { usage: meta.usage } : {}),
        ...(error ? { error } : {})
      }
    },
    sessionId
  )
}

const LONG_RUNNING_COMPLETION_RE =
  /(全部(?:任务|工作|事项).{0,12}(?:完成|已完成)|任务(?:已|已经)?全部完成|all tasks? (?:are )?(?:complete|completed)|work is complete|completed successfully|finished successfully|no further action(?:s)? needed)/i
export const PERSISTED_TASK_TOOL_NAMES = new Set([
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskDelete',
  'TaskList'
])
export const NATIVE_GOAL_TOOL_NAMES = new Set(['get_goal', 'create_goal', 'update_goal'])

function assistantLooksComplete(message?: UnifiedMessage): boolean {
  return LONG_RUNNING_COMPLETION_RE.test(extractMessagePlainText(message))
}

function hasLiveToolOrBackgroundWork(sessionId: string): boolean {
  const agentState = useAgentStore.getState()
  const toolCalls =
    agentState.liveSessionId === sessionId
      ? [...agentState.pendingToolCalls, ...agentState.executedToolCalls]
      : [
          ...(agentState.sessionToolCallsCache[sessionId]?.pending ?? []),
          ...(agentState.sessionToolCallsCache[sessionId]?.executed ?? [])
        ]
  const hasToolStillRunning = toolCalls.some(
    (toolCall) =>
      toolCall.status === 'streaming' ||
      toolCall.status === 'pending_approval' ||
      toolCall.status === 'running'
  )
  if (hasToolStillRunning) return true

  return Object.values(agentState.backgroundProcesses).some(
    (process) => process.sessionId === sessionId && process.status === 'running'
  )
}

export function shouldAutoContinueLongRunningRun(options: {
  sessionId: string
  assistantMessageId: string
  loopEndReason: 'completed' | 'max_iterations' | 'aborted' | 'error' | null
  runUsedTools: boolean
  preRunTaskSnapshot: string
  verificationPassIndex: number
}): boolean {
  const {
    sessionId,
    assistantMessageId,
    loopEndReason,
    runUsedTools,
    preRunTaskSnapshot,
    verificationPassIndex
  } = options

  if (loopEndReason === 'aborted' || loopEndReason === 'error') return false
  if (hasPendingSessionMessages(sessionId) || isPendingSessionDispatchPaused(sessionId))
    return false
  const activeStatus = useAgentStore.getState().runningSessions[sessionId]
  if (activeStatus === 'running' || activeStatus === 'retrying') return false

  const messages = useChatStore.getState().getSessionMessages(sessionId)
  const assistantMessage = messages.find((message) => message.id === assistantMessageId)
  const taskSnapshotChanged = getTaskProgressSnapshot(sessionId) !== preRunTaskSnapshot
  const tasks = useTaskStore.getState().getTasksBySession(sessionId)
  const hasUnfinishedTasks = tasks.some(
    (task) => task.status === 'pending' || task.status === 'in_progress'
  )
  const tailToolExecution = getTailToolExecutionState(messages)
  const hasPendingToolExecution = Boolean(
    tailToolExecution?.toolUseBlocks.some(
      (toolUse) => !tailToolExecution.toolResultMap.has(toolUse.id)
    )
  )
  const completeBySelfReport = assistantLooksComplete(assistantMessage)

  if (hasUnfinishedTasks || hasPendingToolExecution || hasLiveToolOrBackgroundWork(sessionId)) {
    return true
  }

  if (loopEndReason !== 'completed') {
    return true
  }

  // Tool usage alone is too weak a signal to keep auto-continuing for multiple
  // long-running verification passes. Read-only Bash checks in particular can
  // make the run look stuck while it re-verifies the same state repeatedly.
  if (taskSnapshotChanged) {
    return !completeBySelfReport && verificationPassIndex < 2
  }

  if (runUsedTools) {
    return !completeBySelfReport && verificationPassIndex < 1
  }

  if (!completeBySelfReport) {
    return verificationPassIndex < 2
  }

  return false
}

export function findProviderModel(
  providerId: string | null | undefined,
  modelId: string | null | undefined
): { providerName?: string; modelName?: string; modelConfig: AIModelConfig | null } {
  if (!providerId || !modelId) {
    return { modelConfig: null }
  }

  const provider = [...useProviderStore.getState().providers, ...workspaceModelProviders()].find(
    (item) => item.id === providerId
  )
  const model = provider?.models.find((item) => item.id === modelId) ?? null

  return {
    providerName: provider?.name,
    modelName: model?.name ?? modelId,
    modelConfig: model
  }
}

export function estimateCurrentIterationContextTokens(args: {
  sessionId: string
  assistantMessageId: string
  tools: ToolDefinition[]
  providerConfig: ProviderConfig
}): number {
  const session = useChatStore.getState().sessions.find((item) => item.id === args.sessionId)
  if (!session) return 0

  const requestMessages =
    session.messages.length > 0 &&
    session.messages[session.messages.length - 1]?.id === args.assistantMessageId
      ? session.messages.slice(0, -1)
      : session.messages

  return estimateContextTokensForRequest({
    messages: requestMessages,
    tools: args.tools,
    providerConfig: args.providerConfig
  })
}

export function buildProviderConfigWithRuntimeSettings(
  providerConfig: ProviderConfig | null,
  modelConfig: AIModelConfig | null,
  sessionId: string,
  settings = useSettingsStore.getState()
): ProviderConfig | null {
  if (!providerConfig) {
    return settings.apiKey
      ? {
          type: settings.provider,
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl || undefined,
          model: settings.model,
          maxTokens: settings.maxTokens,
          temperature: settings.temperature,
          systemPrompt: settings.systemPrompt || undefined,
          thinkingEnabled: false,
          reasoningEffort: settings.reasoningEffort
        }
      : null
  }

  const effectiveMaxTokens = modelConfig?.maxOutputTokens
    ? Math.min(settings.maxTokens, modelConfig.maxOutputTokens)
    : settings.maxTokens
  const resolvedThinkingConfig = modelConfig?.thinkingConfig ?? providerConfig.thinkingConfig
  const thinkingEnabled = settings.thinkingEnabled && !!resolvedThinkingConfig
  const reasoningEffort = resolveReasoningEffortForModel({
    reasoningEffort: settings.reasoningEffort,
    reasoningEffortByModel: settings.reasoningEffortByModel,
    providerId: providerConfig.providerId,
    modelId: modelConfig?.id ?? providerConfig.model,
    thinkingConfig: resolvedThinkingConfig
  })

  return {
    ...providerConfig,
    maxTokens: effectiveMaxTokens,
    temperature: settings.temperature,
    systemPrompt: settings.systemPrompt || undefined,
    thinkingEnabled,
    thinkingConfig: resolvedThinkingConfig,
    reasoningEffort,
    responseSummary: modelConfig?.responseSummary ?? providerConfig.responseSummary,
    responsesImageGeneration:
      modelConfig?.responsesImageGeneration ?? providerConfig.responsesImageGeneration,
    enablePromptCache: modelConfig?.enablePromptCache ?? providerConfig.enablePromptCache,
    enableSystemPromptCache:
      modelConfig?.enableSystemPromptCache ?? providerConfig.enableSystemPromptCache,
    cacheTtl: modelConfig?.cacheTtl ?? providerConfig.cacheTtl,
    sessionId
  }
}

export async function resolveMainRequestProvider(options: {
  sessionId: string
  latestUserInput: string
  mode?: 'chat' | 'clarify' | 'execute'
  allowTools?: boolean
  isContinue?: boolean
  requiresVision?: boolean
  signal?: AbortSignal
}): Promise<{
  providerConfig: ProviderConfig | null
  modelConfig: AIModelConfig | null
  autoSelection: AutoModelSelectionStatus | null
}> {
  const settings = useSettingsStore.getState()
  const providerStore = useProviderStore.getState()
  const session = useChatStore.getState().sessions.find((item) => item.id === options.sessionId)
  const channelMeta = session?.pluginId
    ? (useChannelStore.getState().channels.find((item) => item.id === session.pluginId) ?? null)
    : null
  const workspaceState = useWorkspaceStore.getState()
  const workspaceSelection = workspaceState.getModelSelection(
    session?.workspaceId ?? workspaceState.activeWorkspaceId
  )
  const sessionModelSelection = resolveSessionModelSelection({
    session,
    providers: [...providerStore.providers, ...workspaceModelProviders()],
    activeProviderId: workspaceSelection?.providerId ?? providerStore.activeProviderId,
    activeModelId: workspaceSelection?.modelId ?? providerStore.activeModelId,
    globalMode: settings.mainModelSelectionMode,
    channelProviderId: channelMeta?.providerId,
    channelModelId: channelMeta?.model
  })

  if (
    sessionModelSelection.effectiveMode === 'manual' &&
    sessionModelSelection.providerId &&
    sessionModelSelection.modelId
  ) {
    const providerConfig = providerStore.getProviderConfigById(
      sessionModelSelection.providerId,
      sessionModelSelection.modelId
    )
    return {
      providerConfig,
      modelConfig: findProviderModel(
        sessionModelSelection.providerId,
        sessionModelSelection.modelId
      ).modelConfig,
      autoSelection: null
    }
  }

  if (sessionModelSelection.effectiveMode === 'auto') {
    if (options.requiresVision) {
      const providerConfig = providerStore.getActiveProviderConfig()
      return {
        providerConfig,
        modelConfig: findProviderModel(providerConfig?.providerId, providerConfig?.model)
          .modelConfig,
        autoSelection: null
      }
    }

    if (!options.latestUserInput) {
      const providerConfig = providerStore.getActiveProviderConfig()
      return {
        providerConfig,
        modelConfig: findProviderModel(providerConfig?.providerId, providerConfig?.model)
          .modelConfig,
        autoSelection: null
      }
    }

    const autoSelection = await selectAutoModel({
      latestUserInput: options.latestUserInput,
      sessionId: options.sessionId,
      mode: options.mode,
      taskProfile: session?.taskProfile,
      allowTools: options.allowTools,
      isContinue: options.isContinue,
      projectId: session?.projectId ?? null,
      signal: options.signal
    })
    const profileFastProviderId = session?.profileConfigSnapshot?.fastProviderId
    const profileFastModelId = session?.profileConfigSnapshot?.fastModelId
    const providerConfig =
      autoSelection.target === 'fast' && profileFastProviderId && profileFastModelId
        ? providerStore.getProviderConfigById(profileFastProviderId, profileFastModelId)
        : autoSelection.target === 'fast'
          ? providerStore.getFastProviderConfig()
          : providerStore.getActiveProviderConfig()
    return {
      providerConfig,
      modelConfig: findProviderModel(providerConfig?.providerId, providerConfig?.model).modelConfig,
      autoSelection
    }
  }

  const providerConfig = providerStore.getActiveProviderConfig()
  return {
    providerConfig,
    modelConfig: findProviderModel(providerConfig?.providerId, providerConfig?.model).modelConfig,
    autoSelection: null
  }
}

export async function resolveHealthyAutoProvider(options: {
  providerConfig: ProviderConfig | null
  modelConfig: AIModelConfig | null
  requiresVision: boolean
}): Promise<{ providerConfig: ProviderConfig | null; modelConfig: AIModelConfig | null }> {
  if (
    !options.providerConfig?.providerId ||
    isOlaManagedProviderId(options.providerConfig.providerId)
  )
    return options
  const providerStore = useProviderStore.getState()
  const candidates = providerStore.providers.flatMap((provider) =>
    provider.models
      .filter((model) => model.enabled !== false)
      .map((model) => ({
        providerId: provider.id,
        modelId: model.id,
        enabled: provider.enabled !== false,
        supportsVision: modelSupportsVision(model, model.type ?? provider.type),
        supportsComputerUse: modelSupportsComputerUse(model, model.type ?? provider.type)
      }))
  )
  const resolution = (await ipcClient.invoke('provider:fallback:resolve', {
    preferredProviderId: options.providerConfig.providerId,
    preferredModelId: options.providerConfig.model,
    candidates,
    requireVision: options.requiresVision
  })) as { selected?: { providerId: string; modelId: string } | null }
  const selected = resolution.selected
  if (
    !selected ||
    (selected.providerId === options.providerConfig.providerId &&
      selected.modelId === options.providerConfig.model)
  ) {
    return options
  }
  const providerConfig = providerStore.getProviderConfigById(selected.providerId, selected.modelId)
  if (!providerConfig) return options
  return {
    providerConfig,
    modelConfig: findProviderModel(selected.providerId, selected.modelId).modelConfig
  }
}

export function messageContainsImage(message: UnifiedMessage): boolean {
  return Array.isArray(message.content) && message.content.some((block) => block.type === 'image')
}

export function latestUserMessageContainsImage(messages: UnifiedMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    return messageContainsImage(message)
  }
  return false
}

export function hasActiveSessionRun(sessionId: string): boolean {
  const hasAbortController = hasSessionAbortController(sessionId)
  const hasStreamingMessage = Boolean(useChatStore.getState().streamingMessages[sessionId])
  const sessionRunStatus = useAgentStore.getState().runningSessions[sessionId]
  const statusIsRunning = sessionRunStatus === 'running' || sessionRunStatus === 'retrying'
  return hasAbortController || hasStreamingMessage || statusIsRunning
}

export function hasActiveSessionRunForSession(sessionId: string): boolean {
  return hasActiveSessionRun(sessionId)
}

function collectMessageToolUseIds(message: UnifiedMessage | undefined): Set<string> {
  const ids = new Set<string>()
  if (!message || !Array.isArray(message.content)) return ids

  for (const block of message.content) {
    if (block.type !== 'tool_use' || !block.id) continue
    ids.add(block.id)
  }
  return ids
}

function collectMessageToolResultIds(message: UnifiedMessage | undefined): Set<string> {
  const ids = new Set<string>()
  if (!message || !Array.isArray(message.content)) return ids

  for (const block of message.content) {
    if (block.type !== 'tool_result' || !block.toolUseId) continue
    ids.add(block.toolUseId)
  }
  return ids
}

function hasUnresolvedTailToolUse(sessionId: string): boolean {
  const chatState = useChatStore.getState()
  const session = chatState.sessions.find((item) => item.id === sessionId)
  if (!session) return false

  const streamingMessageId = chatState.streamingMessages[sessionId] ?? null
  const preferredAssistantIndex = streamingMessageId
    ? session.messages.findIndex((message) => message.id === streamingMessageId)
    : -1
  const startIndex =
    preferredAssistantIndex >= 0 ? preferredAssistantIndex : session.messages.length - 1

  for (let index = startIndex; index >= 0; index -= 1) {
    const message = session.messages[index]
    if (message?.role !== 'assistant') continue

    const toolUseIds = collectMessageToolUseIds(message)
    if (toolUseIds.size === 0) {
      return false
    }

    const pairedToolUseIds = new Set<string>()
    for (
      let candidateIndex = index + 1;
      candidateIndex < session.messages.length;
      candidateIndex += 1
    ) {
      const candidate = session.messages[candidateIndex]
      if (candidate?.role !== 'user') break

      const resultIds = collectMessageToolResultIds(candidate)
      if (resultIds.size === 0) break

      for (const resultId of resultIds) {
        if (toolUseIds.has(resultId)) pairedToolUseIds.add(resultId)
      }
      if (pairedToolUseIds.size === toolUseIds.size) return false
    }

    return true
  }

  return false
}

function requestStopAfterCurrentRequest(sessionId: string): boolean {
  if (!hasActiveSessionRun(sessionId)) return false
  stopAfterCurrentRequestSessions.add(sessionId)
  return true
}

function abortCurrentRunImmediately(sessionId: string): void {
  const activeAbortController = getSessionAbortController(sessionId)
  if (activeAbortController && !activeAbortController.signal.aborted) {
    activeAbortController.abort()
  }
}

export function stopActiveRunAfterCurrentRequest(sessionId: string): void {
  if (!stopAfterCurrentRequestSessions.delete(sessionId)) return
  abortCurrentRunImmediately(sessionId)
}

export function promotePendingSessionMessageForImmediateDispatch(
  sessionId: string,
  messageId: string
): boolean {
  const queue = getQueuedSessionMessages(sessionId)
  if (queue.length === 0) return false

  const index = queue.findIndex((msg) => msg.id === messageId)
  if (index < 0) return false

  const promoted: QueuedSessionMessage = {
    ...queue[index],
    dispatchMode: 'interrupt_next'
  }
  // Move the quoted message to the head so it is the next one dispatched, while
  // preserving the relative order of the remaining queued messages.
  const next = [promoted, ...queue.slice(0, index), ...queue.slice(index + 1)]

  replaceSessionPendingMessages(sessionId, next)
  setPendingSessionDispatchPaused(sessionId, false)

  if (hasActiveSessionRun(sessionId)) {
    // Interrupt the in-flight run immediately so the quoted message is inserted
    // into the conversation right away instead of waiting for the next turn
    // boundary. On run completion, dispatchNextQueuedMessage picks up the head.
    queueMicrotask(() => {
      const activeAbortController = getSessionAbortController(sessionId)
      if (activeAbortController && !activeAbortController.signal.aborted) {
        activeAbortController.abort()
      }
    })
  } else {
    dispatchNextQueuedMessage(sessionId)
  }

  return true
}

export function quotePendingSessionMessageIntoConversation(
  sessionId: string,
  messageId: string
): boolean {
  const queue = getQueuedSessionMessages(sessionId)
  if (queue.length === 0) return false

  const index = queue.findIndex((msg) => msg.id === messageId)
  if (index < 0) return false

  const target = queue[index]
  const hasImages = !!target.images && target.images.length > 0
  const trimmedText = target.text.trim()
  if (!trimmedText && !hasImages && !target.command) return false

  if (hasActiveSessionRun(sessionId) && hasUnresolvedTailToolUse(sessionId)) {
    const remaining = [...queue.slice(0, index), ...queue.slice(index + 1)]
    const processAfterToolResults: QueuedSessionMessage = {
      ...target,
      source: 'quoted',
      dispatchMode: 'after_loop',
      options: target.options ? { ...target.options } : undefined
    }

    replaceSessionPendingMessages(sessionId, [processAfterToolResults, ...remaining])
    setPendingSessionDispatchPaused(sessionId, false)

    if (!requestStopAfterCurrentRequest(sessionId)) {
      dispatchNextQueuedMessage(sessionId)
    }

    return true
  }

  // Render immediately; process after the current provider request finishes.
  const textBlocks: Array<Extract<ContentBlock, { type: 'text' }>> = []
  if (target.command) {
    textBlocks.push({ type: 'text', text: serializeSystemCommand(target.command) })
  }
  if (target.text) {
    textBlocks.push({ type: 'text', text: target.text })
  }
  const userMsg: UnifiedMessage = {
    id: nanoid(),
    role: 'user',
    content: buildUserMessageContent(target.text ?? '', target.images, textBlocks),
    createdAt: Date.now(),
    source: 'quoted'
  }
  addMessageWithSync(sessionId, userMsg)

  const remaining = [...queue.slice(0, index), ...queue.slice(index + 1)]
  const processOnly: QueuedSessionMessage = {
    ...target,
    source: 'quoted',
    dispatchMode: 'after_loop',
    options: { ...(target.options ?? {}), preRenderedUserMessageId: userMsg.id }
  }

  replaceSessionPendingMessages(sessionId, [processOnly, ...remaining])
  setPendingSessionDispatchPaused(sessionId, false)

  if (!requestStopAfterCurrentRequest(sessionId)) {
    dispatchNextQueuedMessage(sessionId)
  }

  return true
}

interface EditableUserMessageTarget {
  index: number
  draft: EditableUserMessageDraft
}

interface RetryAssistantTarget {
  assistantIndex: number
  userIndex: number
  draft: EditableUserMessageDraft
}

type ChatStoreState = ReturnType<typeof useChatStore.getState>

export interface ResolvedUserCommand {
  command: SystemCommandSnapshot | null
  userText: string
  titleInput: string
}

export function canAutoGenerateSessionTitle(currentTitle: string | undefined): boolean {
  const title = (currentTitle ?? '').trim()
  return (
    title.length === 0 ||
    title === 'New Conversation' ||
    title === 'New Chat' ||
    /^oc_/i.test(title) ||
    /^Plugin\s+/i.test(title)
  )
}

export async function resolveUserCommand(
  rawText: string,
  commandOverride?: SystemCommandSnapshot | null
): Promise<ResolvedUserCommand | { error: string }> {
  if (commandOverride) {
    const userText = rawText.trim()
    return {
      command: commandOverride,
      userText,
      titleInput: userText ? `${commandOverride.name} ${userText}` : commandOverride.name
    }
  }

  const parsed = parseSlashCommandInput(rawText)
  if (!parsed) {
    const userText = rawText.trim()
    return {
      command: null,
      userText,
      titleInput: userText
    }
  }

  const loaded = await loadCommandSnapshot(parsed.commandName)
  if ('error' in loaded) {
    if (loaded.notFound) {
      return {
        command: null,
        userText: rawText.trim(),
        titleInput: rawText.trim()
      }
    }

    return { error: loaded.error }
  }

  return {
    command: loaded.command,
    userText: buildSlashCommandUserText(loaded.command.name, parsed.userText, parsed.args),
    titleInput: parsed.userText ? `${loaded.command.name} ${parsed.userText}` : loaded.command.name
  }
}

function formatGoalSummary(goal: SessionGoal): string {
  const lines = [
    '**Goal**',
    `Status: ${goalStatusLabel(goal.status)}`,
    `Objective: ${goal.objective}`,
    `Time used: ${goal.timeUsedSeconds}s`,
    `Tokens used: ${goal.tokensUsed}`
  ]
  if (goal.tokenBudget !== undefined && goal.tokenBudget !== null) {
    lines.push(`Token budget: ${goal.tokenBudget}`)
  }
  const commands =
    goal.status === 'active'
      ? '/goal edit, /goal pause, /goal clear'
      : goal.status === 'complete'
        ? '/goal edit, /goal clear'
        : goal.status === 'paused' ||
            goal.status === 'blocked' ||
            goal.status === 'usage_limited' ||
            goal.status === 'budget_limited'
          ? '/goal edit, /goal resume, /goal clear'
          : '/goal edit, /goal clear'
  lines.push('', `Commands: ${commands}`)
  return lines.join('\n')
}

function appendGoalCommandMessages(
  sessionId: string,
  userText: string,
  assistantText: string
): void {
  const now = Date.now()
  addMessageWithSync(sessionId, {
    id: nanoid(),
    role: 'user',
    content: userText,
    createdAt: now
  })
  addMessageWithSync(sessionId, {
    id: nanoid(),
    role: 'assistant',
    content: assistantText,
    createdAt: now
  })
}

type GoalSlashResult = false | 'handled'

export async function tryHandleGoalSlashCommand(args: {
  sessionId: string
  text: string
  source?: MessageSource
  images?: ImageAttachment[]
  commandOverride?: SystemCommandSnapshot | null
}): Promise<GoalSlashResult> {
  if (args.commandOverride || args.images?.length || args.source === 'continue') return false

  const parsed = parseSlashCommandInput(args.text)
  if (!parsed || parsed.commandName.toLowerCase() !== 'goal') return false

  const goalStore = useGoalStore.getState()
  const current =
    goalStore.getGoalBySession(args.sessionId) ??
    (await goalStore.loadGoalForSession(args.sessionId, true))
  const commandText = args.text.trim() || '/goal'
  const objectiveOrCommand = parsed.userText.trim()
  const control = objectiveOrCommand.toLowerCase()

  if (!objectiveOrCommand) {
    appendGoalCommandMessages(
      args.sessionId,
      commandText,
      current
        ? formatGoalSummary(current)
        : 'No goal is currently set. Use the Goal bar to set one.'
    )
    return 'handled'
  }

  if (control === 'clear') {
    const result = await goalStore.clearGoal(args.sessionId)
    appendGoalCommandMessages(
      args.sessionId,
      commandText,
      result.cleared
        ? 'Goal cleared.'
        : result.error
          ? `Failed to clear goal: ${result.error}`
          : 'No goal is currently set.'
    )
    return 'handled'
  }

  if (control === 'pause' || control === 'resume') {
    if (!current) {
      appendGoalCommandMessages(
        args.sessionId,
        commandText,
        'No goal is currently set. Use the Goal bar to set one first.'
      )
      return 'handled'
    }
    const result = await goalStore.updateGoal(args.sessionId, {
      status: control === 'pause' ? 'paused' : 'active'
    })
    appendGoalCommandMessages(
      args.sessionId,
      commandText,
      result.goal ? formatGoalSummary(result.goal) : `Failed to update goal: ${result.error}`
    )
    return 'handled'
  }

  if (control === 'edit') {
    if (!current) {
      appendGoalCommandMessages(
        args.sessionId,
        commandText,
        'No goal is currently set. Use the Goal bar to set one first.'
      )
      return 'handled'
    }
    const edited = window.prompt('Edit goal objective', current.objective)
    if (edited === null) return 'handled'
    const error = validateGoalObjective(edited)
    if (error) {
      appendGoalCommandMessages(args.sessionId, commandText, error)
      return 'handled'
    }
    const result = await goalStore.updateGoal(args.sessionId, { objective: edited.trim() })
    appendGoalCommandMessages(
      args.sessionId,
      commandText,
      result.goal ? formatGoalSummary(result.goal) : `Failed to edit goal: ${result.error}`
    )
    return 'handled'
  }

  const validationError = validateGoalObjective(objectiveOrCommand)
  if (validationError) {
    appendGoalCommandMessages(args.sessionId, commandText, validationError)
    return 'handled'
  }

  const result = await goalStore.setGoal({
    sessionId: args.sessionId,
    objective: objectiveOrCommand
  })
  appendGoalCommandMessages(
    args.sessionId,
    commandText,
    result.goal ? formatGoalSummary(result.goal) : `Failed to set goal: ${result.error}`
  )
  return 'handled'
}

export function findLastEditableUserMessage(
  messages: UnifiedMessage[]
): EditableUserMessageTarget | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isEditableUserMessage(message)) {
      continue
    }

    return {
      index,
      draft: extractEditableUserMessageDraft(message.content)
    }
  }

  return null
}

export function findEditableUserMessageById(
  messages: UnifiedMessage[],
  messageId: string
): EditableUserMessageTarget | null {
  const index = messages.findIndex((message) => message.id === messageId)
  if (index < 0) return null

  const message = messages[index]
  if (!isEditableUserMessage(message)) return null

  return {
    index,
    draft: extractEditableUserMessageDraft(message.content)
  }
}

function isToolResultOnlyUserMessage(message: UnifiedMessage): boolean {
  return (
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.every((block) => block.type === 'tool_result')
  )
}

export function findRetryAssistantTarget(
  messages: UnifiedMessage[],
  assistantMessageId: string
): RetryAssistantTarget | null {
  const assistantIndex = messages.findIndex(
    (message) => message.id === assistantMessageId && message.role === 'assistant'
  )
  if (assistantIndex < 0) return null

  let userIndex = -1
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isEditableUserMessage(message)) continue
    userIndex = index
    break
  }
  if (userIndex < 0) return null

  return {
    assistantIndex,
    userIndex,
    draft: extractEditableUserMessageDraft(messages[userIndex].content)
  }
}

function shouldReloadSessionMessagesForMutation(
  chatStore: ChatStoreState,
  sessionId: string
): boolean {
  const session = chatStore.sessions.find((item) => item.id === sessionId)
  if (!session) return false

  const knownCount = session.messageCount ?? session.messages.length
  return (
    !session.messagesLoaded ||
    session.messages.length === 0 ||
    session.loadedRangeStart > 0 ||
    session.loadedRangeEnd < knownCount
  )
}

export async function resolveSessionMessageTarget<T>(
  chatStore: ChatStoreState,
  sessionId: string,
  resolver: (messages: UnifiedMessage[]) => T | null
): Promise<{ messages: UnifiedMessage[]; target: T | null }> {
  // Edit / retry / delete rely on absolute message positions. If the session is
  // currently showing only a paged window, a resident-array index is not the
  // same as the DB sort order and follow-up truncation will target the wrong
  // rows. Reload the full transcript before resolving the mutation target.
  if (shouldReloadSessionMessagesForMutation(chatStore, sessionId)) {
    await chatStore.loadSessionMessages(sessionId, true)
  }

  const messages = chatStore.getSessionMessages(sessionId)
  const target = resolver(messages)
  return { messages, target }
}

export function buildDeletedMessages(
  messages: UnifiedMessage[],
  messageId: string
): UnifiedMessage[] | null {
  const targetIndex = messages.findIndex((message) => message.id === messageId)
  if (targetIndex < 0) return null

  const target = messages[targetIndex]
  let deleteEnd = targetIndex + 1

  if (target.role === 'assistant') {
    while (deleteEnd < messages.length && isToolResultOnlyUserMessage(messages[deleteEnd])) {
      deleteEnd += 1
    }
  } else if (isEditableUserMessage(target)) {
    while (deleteEnd < messages.length && !isEditableUserMessage(messages[deleteEnd])) {
      deleteEnd += 1
    }
  } else {
    return null
  }

  return [...messages.slice(0, targetIndex), ...messages.slice(deleteEnd)]
}

export function ensureRequestContainsExpectedUserMessage(
  messages: UnifiedMessage[],
  expectedUserMessage?: UnifiedMessage | null
): UnifiedMessage[] {
  if (!expectedUserMessage || expectedUserMessage.role !== 'user') {
    return messages
  }

  if (messages.some((message) => message.id === expectedUserMessage.id)) {
    return messages
  }

  console.warn('[ChatActions] Restoring missing user message in request payload', {
    messageId: expectedUserMessage.id,
    role: expectedUserMessage.role,
    existingMessageIds: messages.map((message) => message.id)
  })

  return [...messages, expectedUserMessage]
}

function extractToolErrorMessage(output: unknown): string | undefined {
  if (typeof output !== 'string' || !isStructuredToolErrorText(output)) return undefined
  const parsed = decodeStructuredToolResult(output)
  if (!parsed || Array.isArray(parsed)) return undefined
  return typeof parsed.error === 'string' ? parsed.error : undefined
}

export function reconcileIterationToolResults(
  sessionId: string,
  toolResults: { toolUseId: string; content: ToolResultContent; isError?: boolean }[]
): void {
  if (toolResults.length === 0) return

  const agentStore = useAgentStore.getState()
  const sessionToolCalls = agentStore.sessionToolCallsCache[sessionId]
  const candidates = [
    ...agentStore.pendingToolCalls,
    ...agentStore.executedToolCalls,
    ...(sessionToolCalls?.pending ?? []),
    ...(sessionToolCalls?.executed ?? [])
  ]
  const completedAt = Date.now()
  const seen = new Set<string>()

  for (const result of toolResults) {
    if (!result.toolUseId || seen.has(result.toolUseId)) continue
    seen.add(result.toolUseId)

    const existing = candidates.find((toolCall) => toolCall.id === result.toolUseId)
    if (!existing) continue

    if (
      (existing.status === 'completed' || existing.status === 'error') &&
      existing.output !== undefined
    ) {
      continue
    }

    const isError = result.isError === true
    const errorMessage = isError ? extractToolErrorMessage(result.content) : undefined
    const patch: Partial<ToolCallState> = {
      status: isError ? 'error' : 'completed',
      output: result.content,
      ...(errorMessage ? { error: errorMessage } : {}),
      completedAt
    }

    agentStore.updateToolCall(result.toolUseId, patch, sessionId)

    if (existing.name === TASK_TOOL_NAME && existing.input.run_in_background !== true) {
      reconcileSubAgentCompletionFromTaskToolCall(sessionId, {
        ...existing,
        ...patch,
        status: patch.status ?? existing.status,
        output: result.content,
        completedAt
      })
    }
  }
}

function getStoredToolCallResult(
  sessionId: string,
  toolUseId: string
): { content: ToolResultContent; isError: boolean; error?: string } | null {
  const agentState = useAgentStore.getState()
  const sessionCache = agentState.sessionToolCallsCache[sessionId]
  const candidates = [
    ...agentState.pendingToolCalls,
    ...agentState.executedToolCalls,
    ...(sessionCache?.pending ?? []),
    ...(sessionCache?.executed ?? [])
  ]

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const toolCall = candidates[index]
    if (toolCall.id !== toolUseId || toolCall.output === undefined) continue
    return {
      content: toolCall.output,
      isError: toolCall.status === 'error',
      error: toolCall.error
    }
  }

  return null
}

export function collectAvailableContinuationToolResults(
  sessionId: string,
  tailToolExecution: TailToolExecutionState
): {
  toolResultsById: Map<string, { content: ToolResultContent; isError?: boolean }>
  missingToolUses: TailToolExecutionState['toolUseBlocks']
} {
  const toolResultsById = new Map(tailToolExecution.toolResultMap)
  const missingToolUses: TailToolExecutionState['toolUseBlocks'] = []

  for (const toolUse of tailToolExecution.toolUseBlocks) {
    if (toolResultsById.has(toolUse.id)) continue

    const cachedResult = getStoredToolCallResult(sessionId, toolUse.id)
    if (cachedResult) {
      toolResultsById.set(toolUse.id, {
        content: cachedResult.content,
        isError: cachedResult.isError
      })
      continue
    }

    missingToolUses.push(toolUse)
  }

  return { toolResultsById, missingToolUses }
}

// ── Team lead auto-trigger: teammate messages → new agent turn ──

/** Module-level ref to the latest sendMessage function from the hook */
let _sendMessageFn:
  | ((
      text: string,
      images?: ImageAttachment[],
      source?: MessageSource,
      targetSessionId?: string,
      commandOverride?: SystemCommandSnapshot | null,
      reuseAssistantMessageId?: string,
      options?: SendMessageOptions
    ) => Promise<void>)
  | null = null

/**
 * Publishes the hook's `sendMessage` so module-level flows (team lead drain,
 * queued dispatch, plan execution, plugin auto-reply) can start a turn.
 */
export function setSendMessageHandler(
  handler:
    | ((
        text: string,
        images?: ImageAttachment[],
        source?: MessageSource,
        targetSessionId?: string,
        commandOverride?: SystemCommandSnapshot | null,
        reuseAssistantMessageId?: string,
        options?: SendMessageOptions
      ) => Promise<void>)
    | null
): void {
  _sendMessageFn = handler
}

/** Returns the published `sendMessage`, or null before the hook has mounted. */
export function getSendMessageHandler(): typeof _sendMessageFn {
  return _sendMessageFn
}

export function tryDispatchPendingGoalContinuation(sessionId: string): boolean {
  if (!pendingGoalContinuationSessions.has(sessionId)) return false
  if (scheduledGoalContinuationSessions.has(sessionId)) return true
  const currentGoal = useGoalStore.getState().getGoalBySession(sessionId)
  if (currentGoal && currentGoal.status !== 'active') {
    pendingGoalContinuationSessions.delete(sessionId)
    return false
  }
  if (!_sendMessageFn) return false
  if (useUIStore.getState().isPlanModeEnabled(sessionId)) return false
  if (hasActiveSessionRun(sessionId)) return false
  if (hasPendingSessionMessages(sessionId) || isPendingSessionDispatchPaused(sessionId)) {
    return false
  }

  const sendMessage = _sendMessageFn
  if (!sendMessage) return false
  pendingGoalContinuationSessions.delete(sessionId)
  scheduledGoalContinuationSessions.add(sessionId)
  queueMicrotask(() => {
    if (!scheduledGoalContinuationSessions.has(sessionId)) return
    void sendMessage('', undefined, 'continue', sessionId, null)
      .catch((error) => {
        console.warn('[ChatActions] Failed to dispatch goal continuation:', error)
      })
      .finally(() => {
        scheduledGoalContinuationSessions.delete(sessionId)
        tryDispatchPendingGoalContinuation(sessionId)
      })
  })
  return true
}

function clearGoalContinuationState(sessionId: string): void {
  pendingGoalContinuationSessions.delete(sessionId)
  scheduledGoalContinuationSessions.delete(sessionId)
}

let goalContinuationListenerCount = 0
let stopGoalContinuationListener: (() => void) | null = null

export function acquireGoalContinuationListener(): () => void {
  goalContinuationListenerCount += 1

  if (!stopGoalContinuationListener) {
    stopGoalContinuationListener = ipcClient.on('goal:continue-requested', (payload: unknown) => {
      const workspaceId =
        payload && typeof payload === 'object'
          ? (payload as { workspaceId?: unknown }).workspaceId
          : undefined
      if (workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) return
      const sessionId =
        payload && typeof payload === 'object'
          ? (payload as { sessionId?: unknown }).sessionId
          : undefined
      if (typeof sessionId !== 'string' || !sessionId.trim()) return
      const currentGoal = useGoalStore.getState().getGoalBySession(sessionId)
      if (currentGoal && currentGoal.status !== 'active') {
        clearGoalContinuationState(sessionId)
        return
      }
      pendingGoalContinuationSessions.add(sessionId)
      tryDispatchPendingGoalContinuation(sessionId)
    })
  }

  return () => {
    goalContinuationListenerCount = Math.max(0, goalContinuationListenerCount - 1)
    if (goalContinuationListenerCount > 0) return
    stopGoalContinuationListener?.()
    stopGoalContinuationListener = null
  }
}

/** Queue of teammate messages to lead waiting to be processed */
const pendingLeadMessages: { from: string; content: string }[] = []

/** Whether the global team-message listener is registered */
let _teamLeadListenerActive = false

/** Counter for consecutive auto-triggered turns (reset on user-initiated sendMessage) */
let _autoTriggerCount = 0
const MAX_AUTO_TRIGGERS = 10
// 0 => unlimited iterations (run until loop_end by completion/error/abort)
export const DEFAULT_AGENT_MAX_ITERATIONS = 0

/** Debounce timer for batching teammate reports before draining */
let _drainTimer: ReturnType<typeof setTimeout> | null = null
const DRAIN_DEBOUNCE_MS = 800

/** Schedule a debounced drain — collects reports arriving within the window into one batch */
export function scheduleDrain(): void {
  if (_drainTimer) clearTimeout(_drainTimer)
  _drainTimer = setTimeout(() => {
    _drainTimer = null
    drainLeadMessages()
  }, DRAIN_DEBOUNCE_MS)
}

/** Global pause flag — set by stopStreaming to halt all auto-triggering */
let _autoTriggerPaused = false

/**
 * Called at the start of every user-initiated turn so teammate-triggered turns
 * are not throttled by earlier automatic ones.
 */
export function resumeTeamAutoTrigger(): void {
  _autoTriggerCount = 0
  _autoTriggerPaused = false
}

/**
 * Reset the team auto-trigger state. Called from stopStreaming
 * to break the dead loop: abort → completion message → new turn → re-spawn.
 */
export function resetTeamAutoTrigger(): void {
  pendingLeadMessages.length = 0
  _autoTriggerCount = 0
  _autoTriggerPaused = true
}

export function ensurePlanAwaitingReview(planId: string): Plan | null {
  const plan = usePlanStore.getState().plans[planId]
  if (!plan) return null

  if (plan.status !== 'awaiting_review') {
    toast.error(
      i18n.t('plan.awaitingReviewRequired', {
        ns: 'cowork',
        defaultValue: 'This plan is no longer awaiting review.'
      })
    )
    return null
  }

  return plan
}

export async function confirmPlanExecution(options?: { newSession?: boolean }): Promise<boolean> {
  const newSession = options?.newSession === true

  return confirm({
    title: i18n.t(
      newSession ? 'plan.confirmExecuteInNewSessionTitle' : 'plan.confirmExecuteTitle',
      {
        ns: 'cowork',
        defaultValue: newSession
          ? 'Execute approved plan in a new session?'
          : 'Execute approved plan?'
      }
    ),
    description: i18n.t(
      newSession ? 'plan.confirmExecuteInNewSessionDesc' : 'plan.confirmExecuteDesc',
      {
        ns: 'cowork',
        defaultValue: newSession
          ? 'This will create a new session and start implementation from the approved plan.'
          : 'This will start implementation in the current session.'
      }
    ),
    confirmLabel: i18n.t(newSession ? 'plan.executeInNewSession' : 'plan.confirmExecute', {
      ns: 'cowork',
      defaultValue: newSession ? 'New Session Execute' : 'Confirm Execute'
    })
  })
}

/**
 * Set up a persistent listener on teamEvents that captures messages
 * addressed to "lead" and auto-triggers a new main agent turn.
 *
 * Called once; idempotent.
 */
export function ensureTeamLeadListener(): void {
  if (_teamLeadListenerActive) return
  _teamLeadListenerActive = true

  teamEvents.on((event) => {
    if (event.type === 'team_message' && event.message.to === 'lead') {
      pendingLeadMessages.push({ from: event.message.from, content: event.message.content })
      scheduleDrain()
    }
    // Clear queue and reset counter when team is deleted
    if (event.type === 'team_end') {
      pendingLeadMessages.length = 0
      _autoTriggerCount = 0
      if (_drainTimer) {
        clearTimeout(_drainTimer)
        _drainTimer = null
      }
    }
  })
}

/**
 * Drain ALL pending lead messages as a single batched message.
 * Appends team progress info so the lead knows the overall status.
 * Skips if the active session's agent is already running.
 */
function drainLeadMessages(): void {
  if (pendingLeadMessages.length === 0) return
  if (!_sendMessageFn) return
  if (_autoTriggerPaused) return

  // Safety: stop auto-triggering after too many consecutive turns
  if (_autoTriggerCount >= MAX_AUTO_TRIGGERS) {
    console.warn(
      `[Team] Auto-trigger limit reached (${MAX_AUTO_TRIGGERS}). ` +
        `${pendingLeadMessages.length} messages pending. Waiting for user input.`
    )
    return
  }

  const activeSessionId = useChatStore.getState().activeSessionId
  if (!activeSessionId) return

  const status = useAgentStore.getState().runningSessions[activeSessionId]
  if (status === 'running' || status === 'retrying') return

  // Batch all pending messages into one combined message
  const batch = pendingLeadMessages.splice(0, pendingLeadMessages.length)
  const parts = batch.map((msg) => `[Team message from ${msg.from}]:\n${msg.content}`)

  // Append team progress summary so the lead can decide whether to wait or summarize
  const team = useTeamStore.getState().activeTeam
  if (team) {
    const total = team.tasks.length
    const completed = team.tasks.filter((t) => t.status === 'completed').length
    const inProgress = team.tasks.filter((t) => t.status === 'in_progress').length
    const pending = team.tasks.filter((t) => t.status === 'pending').length
    parts.push(
      `\n---\n**Team Progress**: ${completed}/${total} tasks completed` +
        (inProgress > 0 ? `, ${inProgress} in progress` : '') +
        (pending > 0 ? `, ${pending} pending` : '') +
        (completed < total
          ? '. Other teammates are still working — review the report(s) above, then end your turn and wait for remaining reports unless immediate action is needed.'
          : '. All tasks completed — compile the final summary from all reports and then call TeamDelete to clean up the team.')
    )
  }

  const text = parts.join('\n\n')
  _autoTriggerCount++
  _sendMessageFn(text, undefined, 'team')
}

export function dispatchNextQueuedMessage(sessionId: string): boolean {
  const sendQueuedMessage = _sendMessageFn
  if (!sendQueuedMessage) return false

  const sessionExists = useChatStore.getState().sessions.some((s) => s.id === sessionId)
  if (!sessionExists) {
    replaceSessionPendingMessages(sessionId, [])
    return false
  }

  if (isPendingSessionDispatchPaused(sessionId)) return false
  if (hasActiveSessionRun(sessionId)) return false

  const next = dequeuePendingSessionMessage(sessionId)
  if (!next) return false

  markQueuedSessionMessageDispatching(sessionId, next)

  setPendingSessionDispatchPaused(sessionId, false)
  setTimeout(() => {
    void (async () => {
      try {
        await flushPendingSessionQueue(sessionId)
        await sendQueuedMessage(
          next.text,
          next.images,
          next.source ?? 'queued',
          sessionId,
          next.command,
          undefined,
          next.options
        )
        clearDispatchingSessionMessage(sessionId)
        persistCurrentPendingSessionQueue(sessionId)
      } catch (error) {
        clearDispatchingSessionMessage(sessionId)
        const needsReview = { ...next, recoveryState: 'needs_review' as const }
        const current = getQueuedSessionMessages(sessionId)
        replaceSessionPendingMessages(sessionId, [needsReview, ...current])
        setPendingSessionDispatchPaused(sessionId, true)
        console.error('[SessionQueue] Dispatch failed; item returned for review:', error)
      }
    })()
  }, 0)
  return true
}

export function dispatchNextQueuedMessageForSession(sessionId: string): boolean {
  setPendingSessionDispatchPaused(sessionId, false)
  return dispatchNextQueuedMessage(sessionId) || tryDispatchPendingGoalContinuation(sessionId)
}

function abortTeamForSession(sessionId: string, clearPendingApprovals = false): void {
  const team = useTeamStore.getState().activeTeam
  if (team?.sessionId !== sessionId) return

  resetTeamAutoTrigger()
  abortAllTeammates()

  if (clearPendingApprovals) {
    useAgentStore.getState().clearPendingApprovals()
  }
}

function finishStoppingSession(sessionId: string): void {
  setPendingSessionDispatchPaused(sessionId, true)
  clearGoalContinuationState(sessionId)
  stopAfterCurrentRequestSessions.delete(sessionId)

  const ac = getSessionAbortController(sessionId)
  if (ac) ac.abort()

  void ipcClient
    .invoke('hooks:cancel', { key: sessionId })
    .then(() => {
      const projectPath = useChatStore
        .getState()
        .sessions.find((item) => item.id === sessionId)?.workingFolder
      return emitHooks('stop', {
        sessionId,
        projectPath,
        cancellationKey: `${sessionId}:stop`
      })
    })
    .catch(() => {})
  setStreamingMessageIdWithSync(sessionId, null)
  useAgentStore.getState().setSessionStatus(sessionId, 'canceled')
  useRuntimeProjectionStore.getState().finish(sessionId, 'canceled')

  clearPendingQuestions()

  const hasOtherRunning = Object.values(useAgentStore.getState().runningSessions).some(
    (status) => status === 'running' || status === 'retrying'
  )
  if (!hasOtherRunning) {
    useAgentStore.getState().setRunning(false)
    useAgentStore.getState().abort()
  }
}

function stopSessionLocally(sessionId: string): void {
  finishStoppingSession(sessionId)
  abortTeamForSession(sessionId)
}

export function stopSessionStreaming(sessionId: string): void {
  stopSessionLocally(sessionId)
  emitSessionControlSync({ kind: 'stop_streaming', sessionId })
}

function abortSessionLocally(sessionId: string): void {
  finishStoppingSession(sessionId)
  abortTeamForSession(sessionId, true)
}

function applySessionControlSyncEvent(event: SessionControlSyncEvent): void {
  switch (event.kind) {
    case 'stop_streaming':
      stopSessionLocally(event.sessionId)
      return
    case 'abort_session':
      abortSessionLocally(event.sessionId)
      return
  }
}

/**
 * Abort all running tasks for a specific session (agent loop + teammates).
 * Safe to call even if the session has nothing running.
 */
export function abortSession(sessionId: string): void {
  abortSessionLocally(sessionId)
  emitSessionControlSync({ kind: 'abort_session', sessionId })
}
