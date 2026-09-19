import { RuntimeError, type RunSpec } from '../../shared/runtime/contracts'
import type { ExecutionContext } from '../scheduler/run-scheduler'
import { ToolExecutor, type ToolCall } from '../tools/tool-executor'

import type {
  AgentMessage,
  ModelUsage,
  ProviderAdapter,
  ProviderReplay
} from '../../shared/runtime/model'
export type { AgentMessage, ModelDelta, ProviderAdapter } from '../../shared/runtime/model'

export type ToolExecutorResolver = ToolExecutor | ((run: RunSpec) => Promise<ToolExecutor>)

export function createAgentExecutor(
  provider: ProviderAdapter,
  tools: ToolExecutorResolver,
  defaultMaxTurns = 64
) {
  return async (run: RunSpec, context: ExecutionContext): Promise<void> => {
    const toolExecutor = tools instanceof ToolExecutor ? tools : await tools(run)
    const executedToolIds = new Set<string>()
    const maxTurns = run.maxTurns ?? defaultMaxTurns
    const maxToolCalls = run.maxToolCalls ?? 256
    const messages: AgentMessage[] = [
      ...(run.history ?? []).map((message) =>
        message.role === 'assistant'
          ? { role: 'assistant' as const, text: message.text, toolCalls: [] }
          : { role: message.role, text: message.text }
      ),
      { role: 'user', text: run.prompt }
    ]
    for (let turn = 0; turn < maxTurns; turn++) {
      context.signal.throwIfAborted()
      await context.emit('turn.started', { turn })
      let text = ''
      const toolCalls: ToolCall[] = []
      let replay: ProviderReplay | undefined
      let usage: ModelUsage | undefined
      for await (const delta of provider.stream({
        run,
        messages,
        tools: toolExecutor.catalog(),
        signal: context.signal
      })) {
        context.signal.throwIfAborted()
        if (delta.type === 'text') {
          text += delta.text
          if (new TextEncoder().encode(text).byteLength > 128 * 1024)
            throw new RuntimeError('MODEL_OUTPUT_TOO_LARGE')
          await context.emit('message.delta', { text: delta.text })
        } else if (delta.type === 'tool') toolCalls.push(delta.call)
        else if (delta.type === 'thinking')
          await context.emit('thinking.delta', { text: delta.text })
        else if (delta.type === 'replay') replay = delta.replay
        else if (delta.type === 'tool.start' || delta.type === 'tool.arguments')
          await context.emit(delta.type, delta)
        else {
          usage = {
            inputTokens: delta.inputTokens,
            outputTokens: delta.outputTokens,
            ...(delta.cacheReadTokens !== undefined
              ? { cacheReadTokens: delta.cacheReadTokens }
              : {}),
            ...(delta.cacheCreationTokens !== undefined
              ? { cacheCreationTokens: delta.cacheCreationTokens }
              : {}),
            ...(delta.reasoningTokens !== undefined
              ? { reasoningTokens: delta.reasoningTokens }
              : {})
          }
          await context.emit('usage', {
            ...usage
          })
        }
      }
      messages.push({ role: 'assistant', text, toolCalls, ...(replay ? { replay } : {}) })
      // Signed provider replay belongs to model context, not the public UI event stream.
      await context.emit('message.completed', {
        turn,
        text,
        toolCalls,
        ...(usage ? { usage } : {})
      })
      if (!toolCalls.length) return
      if (executedToolIds.size + toolCalls.length > maxToolCalls)
        throw new RuntimeError('TOOL_CALL_LIMIT_EXCEEDED')
      for (const call of toolCalls) {
        if (executedToolIds.has(call.id)) throw new RuntimeError('DUPLICATE_TOOL_CALL')
        executedToolIds.add(call.id)
        await context.emit('tool.generated', { id: call.id, name: call.name, input: call.input })
      }
      const results = await toolExecutor.executeAll(
        toolCalls,
        { run, signal: context.signal, requestInteraction: context.requestInteraction },
        context.emit
      )
      messages.push({ role: 'tool', results })
    }
    throw new RuntimeError('TURN_LIMIT_EXCEEDED')
  }
}
