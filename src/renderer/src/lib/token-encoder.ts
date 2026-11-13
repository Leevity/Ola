type TokenEncoder = (text: string, options: { allowedSpecial: 'all' }) => number[]

let encode: TokenEncoder | null = null
let loading: Promise<void> | null = null
const byteEncoder = new TextEncoder()

// The cl100k vocabulary is ~2 MB. It used to sit in format-tokens.ts, which the whole
// chat UI imports for cost formatting, so it was parsed on every window's first paint.
export function ensureTokenEncoder(): Promise<void> {
  loading ??= import('gpt-tokenizer').then((mod) => {
    encode = mod.encode as TokenEncoder
  })
  return loading
}

/**
 * Estimate the number of tokens in a string using OpenAI's tokenizer (cl100k_base).
 * Use this only when the LLM does not provide token usage — prefer API-reported counts.
 *
 * Callers that feed a context budget must await ensureTokenEncoder() first; the
 * byte-count fallback below is an upper bound, not an estimate.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  if (!encode) {
    void ensureTokenEncoder()
    // Every cl100k token consumes at least one UTF-8 byte, so this never under-reports.
    return byteEncoder.encode(text).length
  }
  return encode(text, { allowedSpecial: 'all' }).length
}
