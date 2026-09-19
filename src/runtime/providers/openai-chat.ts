import type { RunSpec } from '../../shared/runtime/contracts'
import { ProtocolAdapter } from './protocol-adapter'
import { LocalModelTransport } from './transport'

export interface LocalChatTarget {
  baseUrl: string
  model: string
  /** Supplied only by the trusted host, never accepted from a run payload. */
  apiKey?: string
}

/** Compatibility entry point for hosts that only expose Chat Completions. */
export class OpenAIChatAdapter extends ProtocolAdapter {
  constructor(resolve: (run: RunSpec) => Promise<LocalChatTarget>, fetcher: typeof fetch = fetch) {
    super(
      new LocalModelTransport(
        async (run) => ({ ...(await resolve(run)), protocol: 'openai-chat' }),
        fetcher
      )
    )
  }
}
