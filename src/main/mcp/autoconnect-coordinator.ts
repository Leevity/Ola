import type { McpServerConfig } from './mcp-types'

const DEFAULT_MAX_CONCURRENCY = 3
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_INITIAL_BACKOFF_MS = 500
const DEFAULT_CIRCUIT_OPEN_MS = 5 * 60_000

type AutoConnectCoordinatorOptions = {
  maxConcurrency?: number
  maxAttempts?: number
  initialBackoffMs?: number
  circuitOpenMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type McpAutoConnectOutcome =
  | { serverId: string; status: 'connected'; attempts: number }
  | { serverId: string; status: 'circuit-open'; retryAt: number }
  | { serverId: string; status: 'failed'; attempts: number; error: string; retryAt: number }

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class McpAutoConnectCoordinator {
  private readonly circuitOpenUntil = new Map<string, number>()
  private readonly maxConcurrency: number
  private readonly maxAttempts: number
  private readonly initialBackoffMs: number
  private readonly circuitOpenMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: AutoConnectCoordinatorOptions = {}) {
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS
    this.circuitOpenMs = options.circuitOpenMs ?? DEFAULT_CIRCUIT_OPEN_MS
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? defaultSleep
  }

  reset(serverId: string): void {
    this.circuitOpenUntil.delete(serverId)
  }

  async connectEnabled(
    servers: McpServerConfig[],
    connect: (server: McpServerConfig) => Promise<void>
  ): Promise<McpAutoConnectOutcome[]> {
    const outcomes: McpAutoConnectOutcome[] = []
    const queue = servers.filter((server) => server.enabled)
    let cursor = 0
    const workerCount = Math.min(this.maxConcurrency, queue.length)

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (cursor < queue.length) {
          const server = queue[cursor]
          cursor += 1
          outcomes.push(await this.connectOne(server, connect))
        }
      })
    )

    return outcomes
  }

  private async connectOne(
    server: McpServerConfig,
    connect: (server: McpServerConfig) => Promise<void>
  ): Promise<McpAutoConnectOutcome> {
    const currentTime = this.now()
    const retryAt = this.circuitOpenUntil.get(server.id)
    if (retryAt && retryAt > currentTime) {
      return { serverId: server.id, status: 'circuit-open', retryAt }
    }
    this.circuitOpenUntil.delete(server.id)

    let lastError = 'Unknown MCP connection failure'
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        await connect(server)
        this.reset(server.id)
        return { serverId: server.id, status: 'connected', attempts: attempt }
      } catch (error) {
        lastError = toErrorMessage(error)
        if (attempt < this.maxAttempts) {
          await this.sleep(this.initialBackoffMs * 2 ** (attempt - 1))
        }
      }
    }

    const nextRetryAt = this.now() + this.circuitOpenMs
    this.circuitOpenUntil.set(server.id, nextRetryAt)
    return {
      serverId: server.id,
      status: 'failed',
      attempts: this.maxAttempts,
      error: lastError,
      retryAt: nextRetryAt
    }
  }
}
