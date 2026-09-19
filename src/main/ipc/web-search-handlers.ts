import { ipcMain } from 'electron'
import { WebFetchService, type WebFetchRequest } from '../web/web-fetch-service'
import { WebSearchService } from '../web/web-search-service'
import { getWebSearchSecretStore } from '../web/web-search-secret-store'
import {
  migrateLegacyWebSearchSecret,
  resolveWebSearchSecret
} from '../web/web-search-secret-resolution'
import { clearLegacyWebSearchApiKey, readLegacyWebSearchApiKey } from './settings-handlers'
import {
  decodeMessagePackPayload,
  encodeMessagePackPayload,
  toMessagePackChannel
} from '../../shared/messagepack/binary-ipc'

type WebSearchProvider =
  | 'tavily'
  | 'searxng'
  | 'exa'
  | 'exa-mcp'
  | 'bocha'
  | 'zhipu'
  | 'google'
  | 'bing'
  | 'baidu'

interface WebSearchRequest {
  query: string
  provider: WebSearchProvider
  maxResults?: number
  searchMode?: 'web' | 'news'
  apiKey?: string
  timeout?: number
}

const webFetchService = new WebFetchService()
const webSearchService = new WebSearchService()

const WEB_SEARCH_PROVIDERS: WebSearchProvider[] = [
  'tavily',
  'searxng',
  'exa',
  'exa-mcp',
  'bocha',
  'zhipu',
  'google',
  'bing',
  'baidu'
]

function registerWebMessagePackHandler<TArgs>(
  channel: string,
  handler: (args: TArgs) => Promise<unknown>
): void {
  ipcMain.handle(toMessagePackChannel(channel), async (_event, bytes: Uint8Array) => {
    const args = decodeMessagePackPayload<TArgs>(bytes)
    return encodeMessagePackPayload(await handler(args))
  })
}

export function registerWebSearchHandlers(): void {
  const secrets = getWebSearchSecretStore()
  // Every handler waits for this one-time upgrade so a historical key is not
  // briefly unavailable during application startup.
  const legacyMigration = migrateLegacyWebSearchSecret(secrets, {
    readLegacyApiKey: readLegacyWebSearchApiKey,
    clearLegacyApiKey: clearLegacyWebSearchApiKey
  }).catch((error) => {
    console.warn(
      '[WebSearch] Could not migrate legacy API key; retaining it for a later retry:',
      error
    )
  })
  registerWebMessagePackHandler<undefined>('web:search-secret-status', async () => {
    await legacyMigration
    return await secrets.status()
  })
  registerWebMessagePackHandler<{ apiKey: unknown }>('web:search-secret-set', async (args) => {
    await legacyMigration
    return await secrets.set(args?.apiKey)
  })
  registerWebMessagePackHandler<undefined>('web:search-secret-delete', async () => {
    await legacyMigration
    return await secrets.delete()
  })
  registerWebMessagePackHandler<WebSearchRequest>('web:search', async (args) => {
    await legacyMigration
    // Accept one legacy renderer value only long enough to import it into Main
    // storage. Every subsequent search resolves the key in this process.
    const apiKey = await resolveWebSearchSecret(secrets, args?.apiKey)
    const { apiKey: _legacyApiKey, ...request } = args
    return await webSearchService
      .search({ ...request, ...(apiKey ? { apiKey } : {}) })
      .catch((error) => ({
        error: `Web search failed: ${error instanceof Error ? error.message : String(error)}`
      }))
  })

  registerWebMessagePackHandler<WebFetchRequest>('web:fetch', (args) =>
    webFetchService.fetch(args).catch((error) => ({
      error: error instanceof Error ? error.message : String(error)
    }))
  )

  registerWebMessagePackHandler<undefined>(
    'web:search-config',
    async (): Promise<{ providers: WebSearchProvider[] }> => {
      return { providers: WEB_SEARCH_PROVIDERS }
    }
  )

  registerWebMessagePackHandler<undefined>(
    'web:search-providers',
    async (): Promise<WebSearchProvider[]> => {
      return WEB_SEARCH_PROVIDERS
    }
  )
}
