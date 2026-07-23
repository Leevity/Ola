import type {
  ChannelInstance,
  ChannelEvent,
  MessagingChannelService,
  ChannelServiceFactory,
  ChannelWsMessageParser,
  ChannelWsMessageParserLoader
} from './channel-types'
import type { BasePluginService } from './base-plugin-service'

const DEFAULT_MESSAGE_DEDUP_TTL_MS = 15 * 60 * 1000
const DEFAULT_MESSAGE_DEDUP_MAX_PER_PLUGIN = 2_000

export interface ChannelManagerOptions {
  messageDedupTtlMs?: number
  messageDedupMaxPerPlugin?: number
  now?: () => number
}

/**
 * ChannelManager — manages channel service lifecycle with a factory registry pattern.
 * Adding a new provider = register one factory function.
 */
export class ChannelManager {
  private factories = new Map<string, ChannelServiceFactory>()
  private parsers = new Map<string, ChannelWsMessageParser>()
  private parserLoaders = new Map<string, ChannelWsMessageParserLoader>()
  private services = new Map<string, MessagingChannelService>()
  private statuses = new Map<string, 'running' | 'stopped' | 'error'>()
  private readonly seenMessageIds = new Map<string, Map<string, number>>()
  private readonly messageDedupTtlMs: number
  private readonly messageDedupMaxPerPlugin: number
  private readonly now: () => number

  constructor(options: ChannelManagerOptions = {}) {
    this.messageDedupTtlMs = options.messageDedupTtlMs ?? DEFAULT_MESSAGE_DEDUP_TTL_MS
    this.messageDedupMaxPerPlugin =
      options.messageDedupMaxPerPlugin ?? DEFAULT_MESSAGE_DEDUP_MAX_PER_PLUGIN
    this.now = options.now ?? Date.now
  }

  private shouldNotify(event: ChannelEvent): boolean {
    if (event.type !== 'incoming_message') return true
    const messageId =
      event.data && typeof event.data === 'object' && 'messageId' in event.data
        ? String((event.data as { messageId?: unknown }).messageId ?? '').trim()
        : ''
    if (!messageId) return true

    const now = this.now()
    const expiry = now - this.messageDedupTtlMs
    const seen = this.seenMessageIds.get(event.pluginId) ?? new Map<string, number>()
    for (const [id, receivedAt] of seen) {
      if (receivedAt > expiry) break
      seen.delete(id)
    }
    if (seen.has(messageId)) return false

    seen.set(messageId, now)
    while (seen.size > this.messageDedupMaxPerPlugin) {
      const oldest = seen.keys().next().value
      if (oldest === undefined) break
      seen.delete(oldest)
    }
    this.seenMessageIds.set(event.pluginId, seen)
    return true
  }

  /** Register a service factory for a plugin type */
  registerFactory(type: string, factory: ChannelServiceFactory): void {
    this.factories.set(type, factory)
  }

  /** Register a WS message parser for a plugin type */
  registerParser(type: string, parser: ChannelWsMessageParser): void {
    this.parsers.set(type, parser)
  }

  /** Register a deferred parser loader so inactive providers do not load their SDK modules. */
  registerParserLoader(type: string, loader: ChannelWsMessageParserLoader): void {
    this.parserLoaders.set(type, loader)
  }

  /** Start a plugin instance — creates service via factory, calls .start() */
  async startPlugin(
    instance: ChannelInstance,
    notify: (event: ChannelEvent) => void
  ): Promise<void> {
    // Stop existing service if running
    if (this.services.has(instance.id)) {
      await this.stopPlugin(instance.id)
    }

    const factory = this.factories.get(instance.type)
    if (!factory) {
      console.error(`[ChannelManager] No factory registered for type: ${instance.type}`)
      this.statuses.set(instance.id, 'error')
      return
    }

    const service = await factory(instance, (event) => {
      if (this.shouldNotify(event)) notify(event)
    })

    // Wire parser if the service extends BasePluginService
    const parser =
      this.parsers.get(instance.type) ?? (await this.parserLoaders.get(instance.type)?.())
    if (parser) this.parsers.set(instance.type, parser)
    if (parser && typeof (service as BasePluginService).setParser === 'function') {
      ;(service as BasePluginService).setParser(parser)
    }

    this.services.set(instance.id, service)
    this.statuses.set(instance.id, 'stopped')

    try {
      await service.start()
      this.statuses.set(instance.id, 'running')
      console.log(`[ChannelManager] Started channel: ${instance.name} (${instance.id})`)
    } catch (err) {
      console.error(`[ChannelManager] Failed to start channel ${instance.id}:`, err)
      this.statuses.set(instance.id, 'error')
      this.services.delete(instance.id)
      throw err
    }
  }

  async stopPlugin(id: string): Promise<void> {
    const service = this.services.get(id)
    if (!service) return

    try {
      await service.stop()
      console.log(`[ChannelManager] Stopped channel: ${id}`)
    } catch (err) {
      console.error(`[ChannelManager] Error stopping channel ${id}:`, err)
    } finally {
      this.services.delete(id)
      this.statuses.set(id, 'stopped')
    }
  }

  async restartPlugin(
    instance: ChannelInstance,
    notify: (event: ChannelEvent) => void
  ): Promise<void> {
    await this.stopPlugin(instance.id)
    await this.startPlugin(instance, notify)
  }

  getService(id: string): MessagingChannelService | undefined {
    return this.services.get(id)
  }

  getStatus(id: string): 'running' | 'stopped' | 'error' {
    return this.statuses.get(id) ?? 'stopped'
  }

  hasFactory(type: string): boolean {
    return this.factories.has(type)
  }

  async stopAll(): Promise<void> {
    const ids = Array.from(this.services.keys())
    await Promise.allSettled(ids.map((id) => this.stopPlugin(id)))
    console.log(`[ChannelManager] All channels stopped`)
  }
}
