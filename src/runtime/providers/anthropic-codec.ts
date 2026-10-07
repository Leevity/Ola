import { RuntimeError } from '../../shared/runtime/contracts'
import type {
  AgentMessage,
  ModelDelta,
  ModelInput,
  ModelOptions,
  ModelUsage
} from '../../shared/runtime/model'
import type { ModelCodec } from './codec'
import { applyBodyOptions, type ModelTarget } from './transport'
import { runtimeImageSource } from './image-source'
import {
  count,
  object,
  optionalObject,
  parseEvent,
  parseToolInput,
  readServerEvents,
  text
} from './stream'

function messages(
  history: readonly AgentMessage[],
  options: ModelOptions,
  workspaceId: string
): Record<string, unknown>[] {
  const result: Array<{ role: string; content: Record<string, unknown>[] }> = []
  const pending = new Set<string>()
  for (const message of history) {
    if (message.role === 'system') continue
    const blocks: Record<string, unknown>[] = []
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    if (message.role === 'tool') {
      for (const value of message.results) {
        if (!pending.delete(value.id)) throw new RuntimeError('ORPHAN_TOOL_RESULT')
        const output =
          typeof value.output === 'string' ? value.output : (JSON.stringify(value.output) ?? 'null')
        const imageContent = (value.images ?? []).map((image) => {
          const source = runtimeImageSource(image, workspaceId)
          if (!source.startsWith('data:')) throw new RuntimeError('INVALID_RUNTIME_IMAGE')
          const separator = source.indexOf(',')
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: image.mimeType,
              data: source.slice(separator + 1)
            }
          }
        })
        blocks.push({
          type: 'tool_result',
          tool_use_id: value.id,
          content: imageContent.length ? [{ type: 'text', text: output }, ...imageContent] : output,
          ...(value.isError ? { is_error: true } : {})
        })
      }
    } else if (message.role === 'assistant' && message.replay?.protocol === 'anthropic') {
      blocks.push(...structuredClone(message.replay.items))
      for (const block of blocks) if (block.type === 'tool_use') pending.add(text(block.id))
    } else {
      if (message.text) blocks.push({ type: 'text', text: message.text })
      if (message.role === 'assistant')
        for (const call of message.toolCalls) {
          pending.add(call.id)
          blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
        }
      else
        for (const image of message.images ?? [])
          (() => {
            const source = runtimeImageSource(image, workspaceId)
            blocks.push({
              type: 'image',
              source: source.startsWith('data:')
                ? {
                    type: 'base64',
                    media_type: image.mimeType,
                    data: source.slice(source.indexOf(',') + 1)
                  }
                : { type: 'url', url: source }
            })
          })()
    }
    if (!blocks.length) continue
    if (result.at(-1)?.role === role) result.at(-1)!.content.push(...blocks)
    else result.push({ role, content: blocks })
  }
  if (pending.size) throw new RuntimeError('MISSING_TOOL_RESULT')
  if (result.at(-1)?.role !== 'user')
    result.push({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] })
  if (options.enablePromptCache !== false && result.length) {
    const last = result.at(-1)!.content.at(-1)!
    last.cache_control = { type: 'ephemeral', ...(options.cacheTtl === '1h' ? { ttl: '1h' } : {}) }
  }
  return result
}

export const anthropicCodec: ModelCodec = {
  encode(input, target) {
    const options = target.options ?? {},
      maxTokens = options.maxTokens ?? 8192
    const system = [
      options.systemPrompt,
      ...input.messages
        .filter((message) => message.role === 'system')
        .map((message) => ('text' in message ? message.text : ''))
    ]
      .filter(Boolean)
      .join('\n\n')
    let thinking: Record<string, unknown> | undefined
    if (options.thinking?.type === 'adaptive') thinking = { type: 'adaptive' }
    if (options.thinking?.type === 'enabled') {
      if (options.thinking.budgetTokens < 1024 || options.thinking.budgetTokens >= maxTokens)
        throw new RuntimeError('INVALID_THINKING_BUDGET')
      thinking = { type: 'enabled', budget_tokens: options.thinking.budgetTokens }
    }
    return {
      endpoint: 'v1/messages',
      body: applyBodyOptions(
        {
          model: target.model,
          max_tokens: maxTokens,
          stream: true,
          ...(system
            ? {
                system: [
                  {
                    type: 'text',
                    text: system,
                    ...(options.enablePromptCache !== false
                      ? {
                          cache_control: {
                            type: 'ephemeral',
                            ...(options.cacheTtl === '1h' ? { ttl: '1h' } : {})
                          }
                        }
                      : {})
                  }
                ]
              }
            : {}),
          messages: messages(input.messages, options, input.run.workspaceId),
          ...(input.tools.length
            ? {
                tools: input.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.inputSchema
                }))
              }
            : {}),
          ...(thinking
            ? { thinking }
            : options.temperature !== undefined
              ? { temperature: options.temperature }
              : {}),
          ...(options.reasoningEffort ? { output_config: { effort: options.reasoningEffort } } : {})
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
    const blocks = new Map<number, Record<string, unknown>>(),
      argumentsByIndex = new Map<number, string>()
    const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 }
    let stopped = false,
      reason = ''
    for await (const event of readServerEvents(response.body!, input.signal)) {
      if (event.data === '[DONE]') continue
      const frame = parseEvent(event.data),
        type = text(frame.type) || event.event
      const wireUsage = optionalObject(frame.usage ?? optionalObject(frame.message).usage)
      if (wireUsage.input_tokens !== undefined) usage.inputTokens = count(wireUsage.input_tokens)
      if (wireUsage.output_tokens !== undefined) usage.outputTokens = count(wireUsage.output_tokens)
      if (wireUsage.cache_read_input_tokens !== undefined)
        usage.cacheReadTokens = count(wireUsage.cache_read_input_tokens)
      if (wireUsage.cache_creation_input_tokens !== undefined)
        usage.cacheCreationTokens = count(wireUsage.cache_creation_input_tokens)
      if (type === 'error') throw new RuntimeError('PROVIDER_REQUEST_FAILED')
      if (type === 'message_delta') reason = text(optionalObject(frame.delta).stop_reason) || reason
      if (type === 'message_stop') {
        stopped = true
        break
      }
      if (type === 'content_block_start') {
        const index = frame.index
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 1024)
          throw new RuntimeError('INVALID_MODEL_FRAME')
        const block = structuredClone(object(frame.content_block))
        blocks.set(index, block)
        if (block.type === 'tool_use') {
          if (!text(block.id) || !text(block.name)) throw new RuntimeError('INVALID_TOOL_CALL')
          yield { type: 'tool.start', id: text(block.id), name: text(block.name) }
        } else if (block.type === 'text' && text(block.text))
          yield { type: 'text', text: text(block.text) }
        else if (block.type === 'thinking' && text(block.thinking))
          yield { type: 'thinking', text: text(block.thinking) }
      }
      if (type === 'content_block_delta') {
        const block = blocks.get(frame.index as number)
        if (!block) throw new RuntimeError('INVALID_MODEL_FRAME')
        const delta = object(frame.delta)
        if (delta.type === 'text_delta') {
          block.text = text(block.text) + text(delta.text)
          yield { type: 'text', text: text(delta.text) }
        } else if (delta.type === 'thinking_delta') {
          block.thinking = text(block.thinking) + text(delta.thinking)
          yield { type: 'thinking', text: text(delta.thinking) }
        } else if (delta.type === 'signature_delta')
          block.signature = text(block.signature) + text(delta.signature)
        else if (delta.type === 'input_json_delta') {
          const partial =
            (argumentsByIndex.get(frame.index as number) ?? '') + text(delta.partial_json)
          if (partial.length > 1024 * 1024) throw new RuntimeError('MODEL_FRAME_TOO_LARGE')
          argumentsByIndex.set(frame.index as number, partial)
          yield { type: 'tool.arguments', id: text(block.id), delta: text(delta.partial_json) }
        }
      }
    }
    if (!stopped) throw new RuntimeError('MODEL_STREAM_TRUNCATED')
    if (['max_tokens', 'refusal', 'model_context_window_exceeded'].includes(reason))
      throw new RuntimeError('MODEL_OUTPUT_INCOMPLETE')
    const items: Record<string, unknown>[] = [...blocks]
      .sort(([a], [b]) => a - b)
      .map(([index, block]) => ({
        ...block,
        ...(block.type === 'tool_use' && argumentsByIndex.has(index)
          ? { input: parseToolInput(argumentsByIndex.get(index)!) }
          : {})
      }))
    for (const block of items)
      if (block.type === 'tool_use')
        yield {
          type: 'tool',
          call: { id: text(block.id), name: text(block.name), input: block.input ?? {} }
        }
    yield { type: 'usage', ...usage }
    yield { type: 'replay', replay: { protocol: 'anthropic', items } }
  }
}
