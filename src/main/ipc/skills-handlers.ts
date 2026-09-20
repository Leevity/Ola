import { app, shell } from 'electron'
import { tmpdir } from 'node:os'
import * as path from 'path'
import { getDefaultApiUserAgent } from '../lib/api-user-agent'
import { olaExternalDataHome } from '../lib/ola-data-root'
import { registerMessagePackHandler } from './messagepack-handler'
import { SkillCatalog } from '../user-content/skill-catalog'
import { SkillMarketClient } from '../user-content/skill-market-client'
import { scanSkillDirectory } from '../user-content/skill-scanner'
import { cleanupSkillTemporaryDirectory } from '../user-content/skill-archive'

type MutationResult = {
  success: boolean
  error?: string
}

export interface MarketSkillInfo {
  id: string
  slug: string
  name: string
  description: string
  category?: string
  tags: string[]
  downloads: number
  updatedAt?: string
  filePath?: string
  url: string
  downloadUrl: string
  installCommand: string
}

export interface SkillInfo {
  name: string
  description: string
}

export interface ScanFileInfo {
  name: string
  size: number
  type: string
}

export interface RiskItem {
  severity: 'safe' | 'warning' | 'danger'
  category: string
  detail: string
  file: string
  line?: number
}

export interface ScanResult {
  name: string
  description: string
  files: ScanFileInfo[]
  risks: RiskItem[]
  skillMdContent: string
  scriptContents: { file: string; content: string }[]
}

function getBundledSkillDirCandidates(): string[] {
  if (!app.isPackaged) {
    return [path.join(app.getAppPath(), 'resources', 'skills')]
  }

  return [
    path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'skills'),
    path.join(process.resourcesPath, 'resources', 'skills')
  ]
}

export function registerSkillsHandlers(): void {
  const catalog = new SkillCatalog({
    homeDirectory: olaExternalDataHome(),
    bundledDirectoryCandidates: getBundledSkillDirCandidates()
  })
  const marketClient = new SkillMarketClient(getDefaultApiUserAgent())
  void catalog.ensureBuiltins().then((result) => {
    if (result.success) return
    console.error('[Skills] Failed to initialize builtin skills:', result.error)
  })
  registerMessagePackHandler<{ name: string }, MutationResult & { name?: string }>(
    'skills:ensure-builtin',
    async (args) => await catalog.ensureBuiltin(args.name)
  )

  registerMessagePackHandler<undefined, MutationResult>(
    'skills:ensure-builtins',
    async () => await catalog.ensureBuiltins()
  )

  registerMessagePackHandler<undefined, SkillInfo[]>(
    'skills:list',
    async () => await catalog.list()
  )

  registerMessagePackHandler<
    { name: string },
    { content: string; workingDirectory: string } | { error: string }
  >('skills:load', async (args) => await catalog.load(args.name))

  registerMessagePackHandler<{ name: string }, { content: string } | { error: string }>(
    'skills:read',
    async (args) => await catalog.read(args.name)
  )

  registerMessagePackHandler<{ name: string }, { files: ScanFileInfo[] } | { error: string }>(
    'skills:list-files',
    async (args) => await catalog.listFiles(args.name)
  )

  registerMessagePackHandler<{ name: string }, MutationResult>('skills:delete', async (args) =>
    catalog.delete(args.name)
  )

  registerMessagePackHandler<{ name: string }, MutationResult & { path?: string }>(
    'skills:open-folder',
    async (args) => {
      const result = await catalog.resolvePath(args.name)
      if (!result.success || !result.path) return result
      const error = await shell.openPath(result.path)
      return error ? { success: false, error } : { success: true }
    }
  )

  registerMessagePackHandler<{ name: string }, MutationResult & { path?: string }>(
    'skills:resolve-path',
    async (args) => await catalog.resolvePath(args.name)
  )

  registerMessagePackHandler<{ sourcePath: string }, MutationResult & { name?: string }>(
    'skills:add-from-folder',
    async (args) => await catalog.addFromFolder(args.sourcePath)
  )

  registerMessagePackHandler<{ name: string; content: string }, MutationResult>(
    'skills:save',
    async (args) => await catalog.save(args.name, args.content)
  )

  registerMessagePackHandler<{ sourcePath: string }, ScanResult | { error: string }>(
    'skills:scan',
    async (args) => await scanSkillDirectory(args.sourcePath)
  )

  registerMessagePackHandler<
    {
      offset?: number
      limit?: number
      query?: string
      provider?: 'skillsmp'
      apiKey?: string
    },
    { total: number; skills: MarketSkillInfo[] }
  >('skills:market-list', async (args) => await marketClient.list(args))

  registerMessagePackHandler<
    {
      slug?: string
      name: string
      provider?: 'skillsmp'
      apiKey?: string
      skillId?: string
      url?: string
      downloadUrl?: string
    },
    { tempPath?: string; files?: { path: string; content: string }[]; error?: string }
  >('skills:download-remote', async (args) => {
    try {
      return await marketClient.download(args, tmpdir())
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  registerMessagePackHandler<{ tempPath: string }, { success: boolean }>(
    'skills:cleanup-temp',
    async (args) => ({ success: await cleanupSkillTemporaryDirectory(tmpdir(), args.tempPath) })
  )
}
