import { handleNativeAskUserRequest } from '@renderer/lib/tools/ask-user-tool'
import { handleNativeBrowserToolRequest } from '@renderer/lib/tools/browser-native-ui'
import { handleNativePlanUiUpdate } from '@renderer/lib/tools/plan-native-ui'
import { handleNativeTeamUiUpdate } from '@renderer/lib/agent/teams/team-native-ui'
import { decodeIpcMessagePack, invokeMessagePack } from '@renderer/lib/ipc/messagepack-ipc-client'
import {
  RUNTIME_RENDERER_TOOL_REQUEST_MSGPACK_CHANNEL,
  RUNTIME_RENDERER_TOOL_RESPONSE_MSGPACK_CHANNEL
} from '../../../../shared/messagepack/binary-ipc'

// The TypeScript runtime owns the loop and tool execution. This bridge is only
// for renderer/UI boundaries that cannot live inside the main process.

type RendererToolRequestPayload = { requestId: string; method: string; params: unknown }
type RendererToolResponsePayload = { requestId: string; result?: unknown; error?: string }

type RendererToolBridgeWindow = Window & {
  __olaRendererToolBridgeCleanup?: () => void
}

function getBridgeWindow(): RendererToolBridgeWindow {
  return window as RendererToolBridgeWindow
}

async function sendRendererToolResponse(response: RendererToolResponsePayload): Promise<void> {
  await invokeMessagePack(RUNTIME_RENDERER_TOOL_RESPONSE_MSGPACK_CHANNEL, response)
}

async function handleRendererToolRequest(payload: RendererToolRequestPayload): Promise<void> {
  if (
    payload?.method !== 'ask-user/request' &&
    payload?.method !== 'plan/ui-update' &&
    payload?.method !== 'team/ui-update' &&
    payload?.method !== 'browser/tool-request'
  ) {
    return
  }
  if (!payload.requestId) return

  try {
    if (payload.method === 'ask-user/request') {
      await sendRendererToolResponse({
        requestId: payload.requestId,
        result: await handleNativeAskUserRequest(payload.params)
      })
      return
    }

    if (payload.method === 'plan/ui-update') {
      await sendRendererToolResponse({
        requestId: payload.requestId,
        result: await handleNativePlanUiUpdate(payload.params)
      })
      return
    }

    if (payload.method === 'browser/tool-request') {
      await sendRendererToolResponse({
        requestId: payload.requestId,
        result: await handleNativeBrowserToolRequest(payload.params)
      })
      return
    }

    if (payload.method === 'team/ui-update') {
      await sendRendererToolResponse({
        requestId: payload.requestId,
        result: await handleNativeTeamUiUpdate(payload.params)
      })
      return
    }
  } catch (error) {
    await sendRendererToolResponse({
      requestId: payload.requestId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export function attachRendererToolBridge(): void {
  const bridgeWindow = getBridgeWindow()
  bridgeWindow.__olaRendererToolBridgeCleanup?.()
  bridgeWindow.__olaRendererToolBridgeCleanup = undefined
  window.ola.ipc.removeAllListeners(RUNTIME_RENDERER_TOOL_REQUEST_MSGPACK_CHANNEL)

  const msgpackCleanup = window.ola.ipc.on(
    RUNTIME_RENDERER_TOOL_REQUEST_MSGPACK_CHANNEL,
    async (bytes: unknown) => {
      if (!(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes))) return
      await handleRendererToolRequest(decodeIpcMessagePack<RendererToolRequestPayload>(bytes))
    }
  )
  bridgeWindow.__olaRendererToolBridgeCleanup = () => {
    msgpackCleanup()
  }
}
