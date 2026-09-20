import { RuntimeError } from '../../shared/runtime/contracts'
import type { AgentMessage, ModelDelta, ModelInput } from '../../shared/runtime/model'
import type { ModelCodec } from './codec'
import { applyBodyOptions, type ModelTarget } from './transport'
import { runtimeImageSource } from './image-source'
import {
  array,
  count,
  object,
  optionalObject,
  parseEvent,
  parseToolInput,
  readServerEvents,
  text
} from './stream'

function messages(input: readonly AgentMessage[], workspaceId: string): unknown[] {
  return input.flatMap((message): unknown[] => {
    if (message.role === 'tool')
      return message.results.map((result) => ({
        role: 'tool',
        tool_call_id: result.id,
        content:
          typeof result.output === 'string'
            ? result.output
            : (JSON.stringify(result.output) ?? 'null')
      }))
    if (message.role === 'assistant')
      return [
        {
          role: 'assistant',
          content: message.text || null,
          ...(message.toolCalls.length
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.input) }
                }))
              }
            : {})
        }
      ]
    const content = message.images?.length
      ? [
          ...(message.text ? [{ type: 'text', text: message.text }] : []),
          ...message.images.map((image) => ({
            type: 'image_url',
            image_url: { url: runtimeImageSource(image, workspaceId) }
          }))
        ]
      : message.text
    return [{ role: message.role, content }]
  })
}

export const chatCodec: ModelCodec = {
  encode(input, target) {
    const options = target.options ?? {}
    const history = options.systemPrompt
      ? [{ role: 'system' as const, text: options.systemPrompt }, ...input.messages]
      : input.messages
    return {
      endpoint: 'chat/completions',
      body: applyBodyOptions(
        {
          model: target.model,
          messages: messages(history, input.run.workspaceId),
          stream: true,
          stream_options: { include_usage: true },
          ...(options.maxTokens ? { max_completion_tokens: options.maxTokens } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.topP !== undefined ? { top_p: options.topP } : {}),
          ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
          ...(input.tools.length
            ? {
                tools: input.tools.map((tool) => ({
                  type: 'function',
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema
                  }
                }))
              }
            : {})
        },
        options
      )
    }
  },
  async *decode(
    response: Response,
    input: ModelInput,
    _target: ModelTarget
  ): AsyncGenerator<ModelDelta> {
    const calls = new Map<number, { id: string; name: string; args: string }>()
    let finished = false
    for await (const { data } of readServerEvents(response.body!, input.signal)) {
      if (data === '[DONE]') {
        finished = true
        break
      }
      const frame = parseEvent(data)
      if (frame.error) throw new RuntimeError('PROVIDER_REQUEST_FAILED')
      const choice = optionalObject(array(frame.choices)[0]),
        delta = optionalObject(choice.delta)
      if (text(delta.content)) yield { type: 'text', text: text(delta.content) }
      const reasoning = text(delta.reasoning_content) || text(delta.reasoning)
      if (reasoning) yield { type: 'thinking', text: reasoning }
      for (const value of array(delta.tool_calls)) {
        const tool = object(value),
          fn = optionalObject(tool.function)
        if (
          typeof tool.index !== 'number' ||
          !Number.isInteger(tool.index) ||
          tool.index < 0 ||
          tool.index >= 128
        )
          throw new RuntimeError('INVALID_TOOL_BATCH')
        const call = calls.get(tool.index) ?? { id: '', name: '', args: '' }
        if (text(tool.id)) call.id = text(tool.id)
        call.name += text(fn.name)
        call.args += text(fn.arguments)
        if (call.args.length > 1024 * 1024) throw new RuntimeError('MODEL_FRAME_TOO_LARGE')
        calls.set(tool.index, call)
      }
      if (choice.finish_reason === 'length' || choice.finish_reason === 'content_filter')
        throw new RuntimeError('MODEL_OUTPUT_INCOMPLETE')
      if (frame.usage) {
        const usage = object(frame.usage),
          prompt = optionalObject(usage.prompt_tokens_details),
          completion = optionalObject(usage.completion_tokens_details)
        yield {
          type: 'usage',
          inputTokens: count(usage.prompt_tokens),
          outputTokens: count(usage.completion_tokens),
          ...(prompt.cached_tokens !== undefined
            ? { cacheReadTokens: count(prompt.cached_tokens) }
            : {}),
          ...(completion.reasoning_tokens !== undefined
            ? { reasoningTokens: count(completion.reasoning_tokens) }
            : {})
        }
      }
    }
    if (!finished) throw new RuntimeError('MODEL_STREAM_TRUNCATED')
    for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
      if (!call.id || !call.name) throw new RuntimeError('INVALID_TOOL_CALL')
      yield {
        type: 'tool',
        call: { id: call.id, name: call.name, input: parseToolInput(call.args) }
      }
    }
  }
}
