import type {
  ModelDelta,
  ModelInput,
  ModelProtocol,
  ProviderAdapter
} from '../../shared/runtime/model'
import { anthropicCodec } from './anthropic-codec'
import { chatCodec } from './chat-codec'
import type { ModelCodec } from './codec'
import { geminiCodec } from './gemini-codec'
import { responsesCodec } from './responses-codec'
import type { ModelTransport } from './transport'

const codecs: Record<ModelProtocol, ModelCodec> = {
  'openai-chat': chatCodec,
  'openai-responses': responsesCodec,
  anthropic: anthropicCodec,
  gemini: geminiCodec,
  'vertex-ai': geminiCodec
}

export class ProtocolAdapter implements ProviderAdapter {
  constructor(private readonly transport: ModelTransport) {}
  async *stream(input: ModelInput): AsyncGenerator<ModelDelta> {
    const target = await this.transport.resolve(input.run)
    input.signal.throwIfAborted()
    const codec = codecs[target.protocol]
    const request = codec.encode(input, target)
    const response = await this.transport.request(input.run, target, request, input.signal)
    if (input.signal.aborted) {
      await response.body?.cancel().catch(() => undefined)
      input.signal.throwIfAborted()
    }
    yield* codec.decode(response, input, target)
  }
}
