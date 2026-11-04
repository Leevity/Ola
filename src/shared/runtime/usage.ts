/**
 * Token accounting shared by the runtime host and the goal tracker. Both sides
 * already speak these exact fields, so one definition keeps usage from drifting
 * apart across the process boundary.
 */
export interface RuntimeRequestTiming {
  /** Total request duration in milliseconds (request start → message_end). */
  totalMs: number
  /** Time to first token in milliseconds (request start → first streamed content). */
  ttftMs?: number
  /** Output tokens per second, calculated from streamed output. */
  tps?: number
}

export interface RuntimeTokenUsage {
  inputTokens: number
  outputTokens: number
  /** Normalized non-cached input tokens used for pricing/display when available. */
  billableInputTokens?: number
  /** Anthropic prompt caching: tokens written to cache */
  cacheCreationTokens?: number
  /** Anthropic prompt caching: tokens written to 5m cache */
  cacheCreation5mTokens?: number
  /** Anthropic prompt caching: tokens written to 1h cache */
  cacheCreation1hTokens?: number
  /** Anthropic prompt caching: tokens read from cache */
  cacheReadTokens?: number
  /** cacheReadTokens / inputTokens for the normalized request usage. */
  cacheReadRatio?: number
  /** Reasoning model (o3/o4-mini etc.) internal thinking tokens */
  reasoningTokens?: number
  /** Last API call's input tokens — represents current context window usage (not accumulated) */
  contextTokens?: number
  /** Effective context limit used for compression/runtime budgeting on this request */
  contextLength?: number
  /** Total wall time for the full agent run (including tools), in ms. */
  totalDurationMs?: number
  /** Per-request timing metrics for each API call in the loop. */
  requestTimings?: RuntimeRequestTiming[]
}
