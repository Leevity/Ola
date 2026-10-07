import type {
  ProviderConfig,
  StreamEvent,
  ToolDefinition,
  UnifiedMessage
} from '@renderer/lib/api/types'
import {
  RESPONSES_SESSION_SCOPE_AUXILIARY_TEXT_REQUEST,
  withAuxiliaryResponsesRequestPolicy
} from '@renderer/lib/api/responses-session-policy'
import { invokeMessagePackBinary } from '@renderer/lib/ipc/messagepack-ipc-client'
import { isTsRuntimeAvailable, streamTsRuntimeTextTurn } from './ts-runtime-bridge'
import { resolveTsRuntimeModelBinding } from './ts-runtime-model-binding'
import { assessTsRuntimeTextEligibility } from './ts-runtime-text-eligibility'
import { toMessagePackChannel } from '../../../../shared/messagepack/binary-ipc'
import { useWorkspaceStore } from '@renderer/stores/workspace-store'
export { readRuntimeDebugBody } from './runtime-debug-body'

class AgentBridgeClient {
  private initialized = false
  private initializePromise: Promise<boolean> | null = null

  async initialize(): Promise<boolean> {
    if (this.initialized) return true
    if (!this.initializePromise) {
      this.initializePromise = this.initializeWithRetry().finally(() => {
        this.initializePromise = null
      })
    }

    return await this.initializePromise
  }

  private async initializeWithRetry(): Promise<boolean> {
    this.initialized = await isTsRuntimeAvailable().catch(() => false)
    return this.initialized
  }

  async requestCodeGraph<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<T> {
    return await invokeMessagePackBinary<T>(toMessagePackChannel('codegraph:request'), {
      method,
      params,
      timeoutMs
    })
  }

  async stopCodeGraph(): Promise<void> {
    await invokeMessagePackBinary(toMessagePackChannel('codegraph:stop'), {})
  }

  async cancelAgent(
    runId: string,
    toolUseId?: string
  ): Promise<{ cancelled: boolean; runId?: string; toolUseId?: string }> {
    void toolUseId
    return await invokeMessagePackBinary<{
      cancelled: boolean
      runId?: string
      toolUseId?: string
    }>(toMessagePackChannel('agent:request-stop'), {
      workspaceId: useWorkspaceStore.getState().activeWorkspaceId,
      runId
    })
  }

  async lookupToolResults<T = unknown>(args: {
    workspaceId: string
    sessionId: string
    toolUseIds: string[]
  }): Promise<T[]> {
    const result = await invokeMessagePackBinary<{ results: T[]; error?: string }>(
      toMessagePackChannel('agent:tool-results-lookup'),
      args
    )
    if (result.error) throw new Error(result.error)
    return result.results
  }
}

/**
 * Singleton bridge client instance.
 */
export const agentBridge = new AgentBridgeClient()

export async function* streamTsProviderTurn(args: {
  provider: ProviderConfig
  messages: UnifiedMessage[]
  tools: ToolDefinition[]
  planMode?: boolean
  requestContextTexts?: readonly string[]
  includeFullDebugBody?: boolean
  signal?: AbortSignal
}): AsyncGenerator<StreamEvent> {
  void args.tools
  void args.planMode
  void args.requestContextTexts
  void args.includeFullDebugBody
  const binding = resolveTsRuntimeModelBinding(args.provider)
  if (!binding || !(await isTsRuntimeAvailable())) {
    yield {
      type: 'error',
      error: { type: 'ts_runtime_unavailable', message: 'TS Runtime model binding is unavailable.' }
    }
    return
  }
  const userMessages = args.messages.filter((message) => message.role === 'user')
  const prompt = String(userMessages.at(-1)?.content ?? '')
  const history = userMessages.slice(0, -1).map((message) => ({
    role: message.role === 'user' ? ('user' as const) : ('assistant' as const),
    text: String(message.content ?? '')
  }))
  try {
    for await (const event of streamTsRuntimeTextTurn({
      workspaceId: binding.workspaceId,
      sessionId: `ts-provider:${crypto.randomUUID()}`,
      modelSource: binding.modelSource,
      modelOptions: {
        systemPrompt: args.provider.systemPrompt,
        thinking: args.provider.thinkingEnabled === false ? { type: 'disabled' } : undefined
      },
      prompt,
      history,
      signal: args.signal
    })) {
      if (event.type === 'text_delta') yield { type: 'text_delta', text: event.text }
      else if (event.type === 'thinking_delta')
        yield { type: 'thinking_delta', thinking: event.thinking }
      else if (event.type === 'message_end') yield event
      else if (event.type === 'error') yield { type: 'error', error: event.error }
    }
  } catch (error) {
    yield { type: 'error', error: { type: 'ts_runtime_error', message: String(error) } }
  }
}

export async function runTsTextRequest(args: {
  provider: ProviderConfig
  messages: UnifiedMessage[]
  signal?: AbortSignal
  maxIterations?: number
  responsesSessionScope?: string
}): Promise<string> {
  const provider = withAuxiliaryResponsesRequestPolicy(
    args.provider,
    args.responsesSessionScope ?? RESPONSES_SESSION_SCOPE_AUXILIARY_TEXT_REQUEST
  )

  const binding = resolveTsRuntimeModelBinding(provider)
  if (binding && (await isTsRuntimeAvailable())) {
    const eligibility = assessTsRuntimeTextEligibility({
      messages: args.messages,
      provider,
      modelSource: binding.modelSource
    })
    if (eligibility.eligible) {
      let text = ''
      try {
        for await (const event of streamTsRuntimeTextTurn({
          workspaceId: binding.workspaceId,
          sessionId: `auxiliary-text:${crypto.randomUUID()}`,
          modelSource: binding.modelSource,
          modelOptions: eligibility.modelOptions,
          prompt: eligibility.prompt,
          promptImages: eligibility.promptImages,
          history: eligibility.history,
          maxTurns: args.maxIterations ?? 1,
          signal: args.signal
        })) {
          if (event.type === 'text_delta' && event.text) text += event.text
          if (event.type === 'loop_end') break
          if (event.type === 'error') throw event.error
        }
        if (text.trim()) return text
      } catch (error) {
        if (args.signal?.aborted) throw error
        // Do not fall back to a removed runtime. Callers receive an explicit
        // TS runtime error below.
      }
    }
  }

  throw new Error('TS_RUNTIME_TEXT_REQUIRED')
}
