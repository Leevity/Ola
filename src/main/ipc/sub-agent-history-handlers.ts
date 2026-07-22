import { ipcMain } from 'electron'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'
import {
  applySubAgentHistory,
  getSubAgentHistoryMigrationStatus,
  indexSubAgentHistory,
  listSubAgentHistory,
  markSubAgentHistoryMigration,
  replaceSubAgentHistory
} from '../db/sub-agent-history-dao'
import type { SubAgentHistoryUpsertItem } from '../../shared/sub-agent-history-types'

function registerSubAgentHistoryMessagePackHandler<TArgs>(
  channel: string,
  handler: (args: TArgs) => Promise<unknown> | unknown
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<TArgs>(bytes)
    return encodeMessagePackPayload(await handler(args))
  })
}

interface SubAgentHistoryIndexArgs {
  sessionId: string
  limit?: number
}

interface SubAgentHistoryListArgs {
  sessionId: string
  limit?: number
  offset?: number
}

interface SubAgentHistoryReplaceArgs {
  sessionId: string
  items: SubAgentHistoryUpsertItem[]
}

interface SubAgentHistoryMigrationStatusArgs {
  key: string
}

interface SubAgentHistoryMigrationMarkArgs {
  key: string
  appliedAt?: number
}

export function registerSubAgentHistoryHandlers(): void {
  registerSubAgentHistoryMessagePackHandler<SubAgentHistoryIndexArgs>(
    'agent:sub-agent-history:index',
    async (args) => {
      if (!args?.sessionId) return []
      return await indexSubAgentHistory(args.sessionId, args.limit)
    }
  )

  registerSubAgentHistoryMessagePackHandler<SubAgentHistoryListArgs>(
    'agent:sub-agent-history:list',
    async (args) => {
      if (!args?.sessionId) {
        return { items: [], offset: 0, limit: 0, hasMore: false }
      }
      return await listSubAgentHistory(args)
    }
  )

  registerSubAgentHistoryMessagePackHandler<SubAgentHistoryUpsertItem>(
    'agent:sub-agent-history:apply',
    async (item) => {
      if (!item?.sessionId || !item?.id || !item?.toolUseId) {
        return { success: false, changed: 0, error: 'id, sessionId, toolUseId are required' }
      }
      await applySubAgentHistory(item)
      return { success: true, changed: 1, error: null }
    }
  )

  registerSubAgentHistoryMessagePackHandler<SubAgentHistoryReplaceArgs>(
    'agent:sub-agent-history:replace',
    async (args) => {
      if (!args?.sessionId || !Array.isArray(args.items)) {
        return { success: false, changed: 0, error: 'sessionId and items[] are required' }
      }
      await replaceSubAgentHistory(args)
      return { success: true, changed: args.items.length, error: null }
    }
  )

  registerSubAgentHistoryMessagePackHandler<SubAgentHistoryMigrationStatusArgs>(
    'agent:sub-agent-history:migration-status',
    async (args) => {
      if (!args?.key) return { applied: false, appliedAt: null }
      return await getSubAgentHistoryMigrationStatus(args.key)
    }
  )

  registerSubAgentHistoryMessagePackHandler<SubAgentHistoryMigrationMarkArgs>(
    'agent:sub-agent-history:migration-mark',
    async (args) => {
      if (!args?.key) {
        return { success: false, changed: 0, error: 'key is required' }
      }
      await markSubAgentHistoryMigration(args)
      return { success: true, changed: 1, error: null }
    }
  )
}
