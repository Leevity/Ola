import { RuntimeError } from '../../shared/runtime/contracts'
import type { ModelDelta } from '../../shared/runtime/model'
import type { ModelCodec } from './codec'
import { applyBodyOptions } from './transport'
import { runtimeImageSource } from './image-source'
import { array, count, object, optionalObject, parseEvent, readServerEvents, text } from './stream'

export const geminiCodec: ModelCodec = {
  encode(input, target) {
    const options = target.options ?? {}
    const contents: Array<{ role: string; parts: unknown[] }> = []
    const system = [
      options.systemPrompt,
      ...input.messages
        .filter((message) => message.role === 'system')
        .map((message) => ('text' in message ? message.text : ''))
    ]
      .filter(Boolean)
      .join('\n\n')
    for (const message of input.messages) {
      if (message.role === 'system') continue
      const role = message.role === 'assistant' ? 'model' : 'user'
      let parts: unknown[]
      if (message.role === 'tool')
        parts = message.results.map((result) => ({
          functionResponse: {
            name: result.name,
            response: { result: result.output, ...(result.isError ? { error: true } : {}) }
          }
        }))
      else if (message.role === 'assistant')
        parts =
          message.replay?.protocol === target.protocol
            ? message.replay.items
            : [
                ...(message.text ? [{ text: message.text }] : []),
                ...message.toolCalls.map((call) => ({
                  functionCall: { name: call.name, args: call.input },
                  ...(call.signature ? { thoughtSignature: call.signature } : {})
                }))
              ]
      else
        parts = [
          ...(message.text ? [{ text: message.text }] : []),
          ...(message.images ?? []).map((image) =>
            image.data
              ? { inlineData: { mimeType: image.mimeType, data: image.data } }
              : image.assetId
                ? {
                    inlineData: {
                      mimeType: image.mimeType,
                      data: runtimeImageSource(image, input.run.workspaceId).split(',', 2)[1]
                    }
                  }
                : { fileData: { mimeType: image.mimeType, fileUri: image.url } }
          )
        ]
      if (contents.at(-1)?.role === role) contents.at(-1)!.parts.push(...parts)
      else contents.push({ role, parts })
    }
    const thinking = options.thinkingLevel
      ? { thinkingLevel: options.thinkingLevel }
      : options.thinking?.type === 'enabled'
        ? { thinkingBudget: options.thinking.budgetTokens }
        : options.thinking?.type === 'disabled'
          ? { thinkingBudget: 0 }
          : undefined
    return {
      endpoint: `models/${encodeURIComponent(target.model)}:streamGenerateContent?alt=sse`,
      body: applyBodyOptions(
        {
          contents,
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          generationConfig: {
            ...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(options.topP !== undefined ? { topP: options.topP } : {}),
            ...(thinking ? { thinkingConfig: { ...thinking, includeThoughts: true } } : {})
          },
          ...(input.tools.length
            ? {
                tools: [
                  {
                    functionDeclarations: input.tools.map((tool) => ({
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.inputSchema
                    }))
                  }
                ]
              }
            : {})
        },
        options
      )
    }
  },
  async *decode(response, input, target): AsyncGenerator<ModelDelta> {
    let finished = false
    const parts: Record<string, unknown>[] = []
    const calls: Array<{ id: string; name: string; input: unknown; signature?: string }> = []
    for await (const { data } of readServerEvents(response.body!, input.signal)) {
      const frame = parseEvent(data)
      if (frame.error) throw new RuntimeError('PROVIDER_REQUEST_FAILED')
      if (optionalObject(frame.promptFeedback).blockReason)
        throw new RuntimeError('MODEL_OUTPUT_BLOCKED')
      const candidate = optionalObject(array(frame.candidates)[0])
      for (const value of array(optionalObject(candidate.content).parts)) {
        const part = object(value)
        parts.push(part)
        if (parts.length > 16384) throw new RuntimeError('MODEL_FRAME_TOO_LARGE')
        if (text(part.text))
          yield { type: part.thought === true ? 'thinking' : 'text', text: text(part.text) }
        if (part.functionCall) {
          const fn = object(part.functionCall),
            name = text(fn.name)
          if (!name || calls.length >= 128) throw new RuntimeError('INVALID_TOOL_CALL')
          const id =
            text(fn.id) || `gemini_${input.run.runId}_${input.messages.length}_${calls.length}`
          if (calls.some((call) => call.id === id)) throw new RuntimeError('DUPLICATE_TOOL_CALL')
          calls.push({
            id,
            name,
            input: fn.args === undefined ? {} : object(fn.args),
            ...(text(part.thoughtSignature) ? { signature: text(part.thoughtSignature) } : {})
          })
          yield { type: 'tool.start', id, name }
        }
      }
      if (frame.usageMetadata) {
        const usage = object(frame.usageMetadata)
        yield {
          type: 'usage',
          inputTokens: count(usage.promptTokenCount),
          outputTokens: count(usage.candidatesTokenCount),
          cacheReadTokens: count(usage.cachedContentTokenCount),
          reasoningTokens: count(usage.thoughtsTokenCount)
        }
      }
      if (candidate.finishReason) {
        if (candidate.finishReason !== 'STOP') throw new RuntimeError('MODEL_OUTPUT_INCOMPLETE')
        finished = true
      }
    }
    if (!finished) throw new RuntimeError('MODEL_STREAM_TRUNCATED')
    for (const call of calls) yield { type: 'tool', call }
    yield { type: 'replay', replay: { protocol: target.protocol, items: parts } }
  }
}
