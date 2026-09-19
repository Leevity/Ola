import { toolRegistry } from '../agent/tool-registry'
import { encodeStructuredToolResult, encodeToolError } from './tool-result-format'
import type { ToolHandler } from './tool-types'
import { ipcClient } from '../ipc/ipc-client'
import { IPC } from '../ipc/channels'
import { useSettingsStore } from '@renderer/stores/settings-store'

// Web search provider types
export type WebSearchProvider =
  | 'tavily'
  | 'searxng'
  | 'exa'
  | 'exa-mcp'
  | 'bocha'
  | 'zhipu'
  | 'google'
  | 'bing'
  | 'baidu'

export interface WebSearchConfig {
  provider: WebSearchProvider
  apiKey?: string
  searchEngine?: string // For local search engines
  maxResults?: number
  timeout?: number
}

const webSearchHandler: ToolHandler = {
  definition: {
    name: 'WebSearch',
    description:
      "Search the web using the user's configured provider. The model cannot choose or override the provider.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to execute'
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results to return',
          default: 5
        },
        searchMode: {
          type: 'string',
          description: 'Search mode (web, news, etc.)',
          enum: ['web', 'news'],
          default: 'web'
        }
      },
      required: ['query']
    }
  },
  execute: async (input) => {
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (!query) return encodeToolError('query is required')
    const settings = useSettingsStore.getState()
    const maxResults =
      typeof input.maxResults === 'number' && Number.isFinite(input.maxResults)
        ? Math.max(1, Math.min(Math.trunc(input.maxResults), 20))
        : settings.webSearchMaxResults
    try {
      const result = await ipcClient.invoke(IPC.WEB_SEARCH, {
        query,
        provider: settings.webSearchProvider,
        maxResults,
        searchMode: input.searchMode === 'news' ? 'news' : 'web',
        timeout: settings.webSearchTimeout
      })
      return encodeStructuredToolResult(
        result && typeof result === 'object'
          ? { ...(result as Record<string, unknown>) }
          : { result }
      )
    } catch (error) {
      return encodeToolError(error instanceof Error ? error.message : String(error))
    }
  },
  requiresApproval: () => false
}

const webFetchHandler: ToolHandler = {
  definition: {
    name: 'WebFetch',
    description:
      'Fetch one or more URLs and return page content. Accepts url or urls (string or string array) and defaults to markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'A single URL to fetch'
        },
        urls: {
          type: 'array',
          items: {
            type: 'string'
          },
          minItems: 1,
          description: 'A list of URLs to fetch'
        },
        format: {
          type: 'string',
          enum: ['markdown', 'text', 'html'],
          default: 'markdown',
          description: 'Output format, defaults to markdown'
        }
      },
      additionalProperties: false
    }
  },
  execute: async (input) => {
    const rawUrls = input.urls ?? input.url
    const urls = Array.isArray(rawUrls)
      ? rawUrls.filter((value): value is string => typeof value === 'string')
      : typeof rawUrls === 'string'
        ? [rawUrls]
        : []
    if (urls.length === 0) return encodeToolError('url or urls is required')
    const format = input.format === 'text' || input.format === 'html' ? input.format : 'markdown'
    try {
      const result = await ipcClient.invoke(IPC.WEB_FETCH, { urls, format })
      return encodeStructuredToolResult(
        result && typeof result === 'object'
          ? { ...(result as Record<string, unknown>) }
          : { result }
      )
    } catch (error) {
      return encodeToolError(error instanceof Error ? error.message : String(error))
    }
  },
  requiresApproval: () => false
}

let _registered = false

export function registerWebSearchTool(): void {
  if (_registered) return
  _registered = true
  toolRegistry.register(webSearchHandler)
  toolRegistry.register(webFetchHandler)
}

export function unregisterWebSearchTool(): void {
  if (!_registered) return
  _registered = false
  toolRegistry.unregister(webSearchHandler.definition.name)
  toolRegistry.unregister(webFetchHandler.definition.name)
}

export function isWebSearchToolRegistered(): boolean {
  return _registered
}
