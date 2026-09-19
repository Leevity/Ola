import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'

export interface PromptCatalogOptions {
  userDirectory: string
  bundledDirectoryCandidates: string[]
}

async function markdownFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.md')
      .map((entry) => resolve(directory, entry.name))
      .sort((left, right) =>
        basename(left).localeCompare(basename(right), undefined, { sensitivity: 'base' })
      )
  } catch {
    return []
  }
}

function promptFilename(name: string): string | null {
  const trimmed = name.trim()
  const filename = basename(trimmed.replace(/\\/g, '/'))
  if (!filename || filename === '.' || filename === '..') return null
  return extname(filename).toLowerCase() === '.md' ? filename : `${filename}.md`
}

/** Main-owned, local prompt catalog. User copies override bundled templates. */
export class PromptCatalog {
  constructor(private readonly options: PromptCatalogOptions) {}

  private get userDirectory(): string {
    return resolve(this.options.userDirectory)
  }

  private get bundledDirectory(): string {
    return (
      this.options.bundledDirectoryCandidates
        .map((candidate) => resolve(candidate))
        .find(existsSync) ?? resolve(this.options.bundledDirectoryCandidates[0] ?? 'prompts')
    )
  }

  async ensure(): Promise<{ success: boolean; error?: string }> {
    try {
      if (!existsSync(this.bundledDirectory)) return { success: true }
      await mkdir(this.userDirectory, { recursive: true })
      for (const source of await markdownFiles(this.bundledDirectory)) {
        const destination = resolve(this.userDirectory, basename(source))
        if (!existsSync(destination)) await copyFile(source, destination)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async list(): Promise<string[]> {
    if (!(await this.ensure()).success) return []
    return (await markdownFiles(this.userDirectory)).map((path) => basename(path, extname(path)))
  }

  async load(name: string): Promise<{ content: string } | { error: string }> {
    const ready = await this.ensure()
    if (!ready.success) return { error: ready.error ?? 'Prompt directory is unavailable' }
    const filename = promptFilename(name)
    if (!filename) return { error: 'Prompt name is required' }
    const userPath = resolve(this.userDirectory, filename)
    const bundledPath = resolve(this.bundledDirectory, filename)
    const path = existsSync(userPath) ? userPath : existsSync(bundledPath) ? bundledPath : null
    if (!path) return { error: `Prompt "${name.trim()}" not found` }
    try {
      return { content: await readFile(path, 'utf8') }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
}
