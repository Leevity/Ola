import { getDefaultApiUserAgent } from '../lib/api-user-agent'
import { homedir } from 'node:os'
import { olaDataRoot } from '../lib/ola-data-root'
import { registerMessagePackHandler } from './messagepack-handler'
import { getBundledResourceDirCandidates } from '../resources/bundled-resources'
import {
  BUILTIN_SOUL_TEMPLATES,
  type BuiltinSoulTemplateWithContent
} from '../../shared/builtin-souls'
import { SoulLocalCatalog } from '../user-content/soul-local-catalog'
import { SoulMarketClient } from '../user-content/soul-market-client'
import type { SoulCategory, SoulMarketItem } from '../user-content/soul-market-contract'

export type SoulMarketInfo = SoulMarketItem
export type SoulCategoryInfo = SoulCategory

export function registerSoulsHandlers(): void {
  const localCatalog = new SoulLocalCatalog({
    homeDirectory: homedir(),
    olaDataRoot: olaDataRoot(),
    bundledDirectoryCandidates: getBundledResourceDirCandidates('souls')
  })
  const marketClient = new SoulMarketClient({ userAgent: getDefaultApiUserAgent() })
  registerMessagePackHandler<
    undefined,
    { templates: BuiltinSoulTemplateWithContent[]; error?: string }
  >('souls:builtin-list', async () => {
    return await localCatalog.builtinList(BUILTIN_SOUL_TEMPLATES)
  })

  registerMessagePackHandler<
    {
      query?: string
      category?: string
      offset?: number
      limit?: number
      sortBy?: 'recent' | 'name'
      apiKey?: string
    },
    { total: number; souls: SoulMarketInfo[]; error?: string }
  >('souls:market-list', async (args) => {
    try {
      return await marketClient.list(args)
    } catch (error) {
      return { total: 0, souls: [], error: errorMessage(error) }
    }
  })

  registerMessagePackHandler<{ apiKey?: string } | undefined, { categories: SoulCategoryInfo[] }>(
    'souls:categories',
    async (args) => {
      return { categories: await marketClient.categories(args?.apiKey) }
    }
  )

  registerMessagePackHandler<
    { slug?: string; downloadUrl?: string; apiKey?: string },
    { content?: string; error?: string }
  >('souls:download-remote', async (args) => {
    try {
      return { content: await marketClient.download(args) }
    } catch (error) {
      return { error: errorMessage(error) }
    }
  })

  registerMessagePackHandler<{ projectRootPath?: string } | undefined>(
    'souls:get-target-paths',
    async (args) => {
      return localCatalog.targetPaths(args?.projectRootPath)
    }
  )

  registerMessagePackHandler<
    { content?: string; target?: 'global' | 'project'; projectRootPath?: string },
    { success: boolean; path?: string; error?: string }
  >('souls:install', async (args) => {
    return await localCatalog.install(args)
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
