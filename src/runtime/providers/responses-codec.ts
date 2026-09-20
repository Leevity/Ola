import { RuntimeError } from '../../shared/runtime/contracts'
import type { ModelDelta } from '../../shared/runtime/model'
import type { ModelCodec } from './codec'
import { applyBodyOptions } from './transport'
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

export const responsesCodec: ModelCodec = {
  encode(input, target) {
    const options = target.options ?? {}
    const history = input.messages.flatMap((message): unknown[] => {
      if (message.role === 'tool')
        return message.results.map((result) => ({
          type: 'function_call_output',
          call_id: result.id,
          output:
            typeof result.output === 'string'
              ? result.output
              : (JSON.stringify(result.output) ?? 'null')
        }))
      if (message.role === 'assistant') {
        if (message.replay?.protocol === 'openai-responses') return message.replay.items
        return [
          ...(message.text
            ? [{ role: 'assistant', content: [{ type: 'output_text', text: message.text }] }]
            : []),
          ...message.toolCalls.map((call) => ({
            type: 'function_call',
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.input)
          }))
        ]
      }
      return [
        {
          role: message.role,
          content: [
            { type: 'input_text', text: message.text },
            ...(message.images ?? []).map((image) => ({
              type: 'input_image',
              image_url: runtimeImageSource(image, input.run.workspaceId)
            }))
          ]
        }
      ]
    })
    return {
      endpoint: 'responses',
      body: applyBodyOptions(
        {
          model: target.model,
          input: history,
          stream: true,
          store: false,
          ...(options.systemPrompt ? { instructions: options.systemPrompt } : {}),
          ...(options.maxTokens ? { max_output_tokens: options.maxTokens } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.topP !== undefined ? { top_p: options.topP } : {}),
          ...(options.serviceTier ? { service_tier: options.serviceTier } : {}),
          ...(options.promptCacheKey ? { prompt_cache_key: options.promptCacheKey } : {}),
          ...(options.reasoningEffort
            ? {
                reasoning: { effort: options.reasoningEffort, summary: 'auto' },
                include: ['reasoning.encrypted_content']
              }
            : {}),
          ...(input.tools.length
            ? {
                tools: input.tools.map((tool) => ({
                  type: 'function',
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema
                }))
              }
            : {})
        },
        options
      )
    }
  },
  async *decode(response, input): AsyncGenerator<ModelDelta> {
    const items = new Map<number, Record<string, unknown>>()
    const streamedText = new Set<number>()
    let completed: Record<string, unknown> | undefined
    for await (const event of readServerEvents(response.body!, input.signal)) {
      if (event.data === '[DONE]') break
      const frame = parseEvent(event.data),
        kind = text(frame.type) || event.event
      const index = frame.output_index
      if (
        index !== undefined &&
        (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= 1024)
      )
        throw new RuntimeError('INVALID_MODEL_FRAME')
      const position = typeof index === 'number' ? index : 0
      if (kind === 'response.output_text.delta') {
        streamedText.add(position)
        if (text(frame.delta)) yield { type: 'text', text: text(frame.delta) }
      } else if (kind === 'response.reasoning_summary_text.delta') {
        if (text(frame.delta)) yield { type: 'thinking', text: text(frame.delta) }
      } else if (kind === 'response.output_item.added' || kind === 'response.output_item.done') {
        const item = object(frame.item)
        items.set(position, item)
        if (kind.endsWith('added') && item.type === 'function_call')
          yield { type: 'tool.start', id: text(item.call_id), name: text(item.name) }
      } else if (kind === 'response.function_call_arguments.delta') {
        const item = items.get(position)
        if (!item || item.type !== 'function_call') throw new RuntimeError('INVALID_TOOL_CALL')
        item.arguments = text(item.arguments) + text(frame.delta)
        if (text(item.arguments).length > 1024 * 1024)
          throw new RuntimeError('MODEL_FRAME_TOO_LARGE')
        yield { type: 'tool.arguments', id: text(item.call_id), delta: text(frame.delta) }
      } else if (kind === 'response.function_call_arguments.done') {
        const item = items.get(position)
        if (!item) throw new RuntimeError('INVALID_TOOL_CALL')
        item.arguments = text(frame.arguments)
      } else if (kind === 'error' || kind === 'response.failed')
        throw new RuntimeError('PROVIDER_REQUEST_FAILED')
      else if (kind === 'response.incomplete') throw new RuntimeError('MODEL_OUTPUT_INCOMPLETE')
      else if (kind === 'response.completed' || kind === 'response.done') {
        completed = object(frame.response)
        if (completed.status && completed.status !== 'completed')
          throw new RuntimeError('MODEL_OUTPUT_INCOMPLETE')
        break
      }
    }
    if (!completed) throw new RuntimeError('MODEL_STREAM_TRUNCATED')
    const output = Array.isArray(completed.output)
      ? completed.output.map(object)
      : [...items].sort(([a], [b]) => a - b).map(([, item]) => item)
    const ids = new Set<string>()
    for (const [index, item] of output.entries()) {
      if (item.type === 'function_call') {
        const id = text(item.call_id),
          name = text(item.name)
        if (!id || !name || ids.has(id)) throw new RuntimeError('INVALID_TOOL_CALL')
        ids.add(id)
        yield { type: 'tool', call: { id, name, input: parseToolInput(text(item.arguments)) } }
      } else if (item.type === 'message' && !streamedText.has(index)) {
        for (const part of array(item.content).map(object))
          if (part.type === 'output_text' && text(part.text))
            yield { type: 'text', text: text(part.text) }
      }
    }
    const usage = optionalObject(completed.usage)
    yield {
      type: 'usage',
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
      cacheReadTokens: count(optionalObject(usage.input_tokens_details).cached_tokens),
      reasoningTokens: count(optionalObject(usage.output_tokens_details).reasoning_tokens)
    }
    yield {
      type: 'replay',
      replay: {
        protocol: 'openai-responses',
        items: output,
        ...(text(completed.id) ? { responseId: text(completed.id) } : {})
      }
    }
  }
}
