import type {
  ChannelInstance,
  ChannelEvent,
  ChannelMessage,
  ChannelGroup,
  MessagingChannelService
} from '../../channel-types'
import { BasePluginService } from '../../base-plugin-service'
import { TelegramApi } from './telegram-api'
import { decodeMessageReplyReference } from '../../message-reply-reference'

export class TelegramService extends BasePluginService {
  readonly pluginType = 'telegram-bot'
  private api!: TelegramApi

  protected async onStart(): Promise<void> {
    const { botToken } = this._instance.config
    if (!botToken) {
      throw new Error('Missing required config: Bot Token must be provided')
    }
    this.api = new TelegramApi(botToken)
    await this.api.validate()
  }

  async sendMessage(chatId: string, content: string): Promise<{ messageId: string }> {
    return this.api.sendMessage(chatId, content)
  }

  async replyMessage(messageId: string, content: string): Promise<{ messageId: string }> {
    const reference = decodeMessageReplyReference(messageId)
    if (!reference) {
      throw new Error('Telegram reply target is unavailable; send the message to a chat instead')
    }
    return this.api.replyMessage(reference.messageId, reference.chatId, content)
  }

  async getGroupMessages(_chatId: string, _count?: number): Promise<ChannelMessage[]> {
    // Telegram Bot API doesn't support fetching message history
    return []
  }

  async listGroups(): Promise<ChannelGroup[]> {
    // Telegram Bot API doesn't support listing groups
    return []
  }
}

export function createTelegramService(
  instance: ChannelInstance,
  notify: (event: ChannelEvent) => void
): MessagingChannelService {
  return new TelegramService(instance, notify)
}
