import type { PendingRuntimeInteraction } from '../../../../shared/runtime/contracts'
import { handleNativeBrowserToolRequest } from '../tools/browser-native-ui'
import { respondTsRuntimeInteraction } from './ts-runtime-bridge'

const BROWSER_TOOL_NAMES = new Set([
  'BrowserNavigate',
  'BrowserGetContent',
  'BrowserScreenshot',
  'BrowserSnapshot',
  'BrowserClick',
  'BrowserType',
  'BrowserScroll'
])

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export async function resolveTsRuntimeBrowserInteraction(
  interaction: PendingRuntimeInteraction,
  sessionId: string
): Promise<void> {
  const payload = record(interaction.payload)
  const toolName = payload?.toolName
  const input = record(payload?.input)
  if (
    interaction.kind !== 'browser-tool' ||
    !payload ||
    !input ||
    typeof toolName !== 'string' ||
    !BROWSER_TOOL_NAMES.has(toolName) ||
    payload.sessionId !== sessionId ||
    (payload.projectId !== null && typeof payload.projectId !== 'string') ||
    (payload.workingFolder !== null && typeof payload.workingFolder !== 'string')
  ) {
    await respondTsRuntimeInteraction({
      workspaceId: interaction.workspaceId,
      runId: interaction.runId,
      interactionId: interaction.interactionId,
      response: { browserToolResult: 'BROWSER_INTERACTION_INVALID', isError: true }
    })
    return
  }
  const result = await handleNativeBrowserToolRequest({
    toolName,
    input,
    sessionId,
    projectId: payload.projectId,
    workingFolder: payload.workingFolder,
    agentRunId: interaction.runId
  })
  await respondTsRuntimeInteraction({
    workspaceId: interaction.workspaceId,
    runId: interaction.runId,
    interactionId: interaction.interactionId,
    response: {
      browserToolResult: result.content,
      ...(result.isError ? { isError: true } : {})
    }
  })
}
