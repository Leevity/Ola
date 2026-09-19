import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import type {
  BuiltinSoulTemplate,
  BuiltinSoulTemplateWithContent
} from '../../shared/builtin-souls'

export class SoulLocalCatalog {
  constructor(
    private readonly options: {
      homeDirectory: string
      olaDataRoot?: string
      bundledDirectoryCandidates: string[]
    }
  ) {}

  async builtinList(
    templates: readonly BuiltinSoulTemplate[]
  ): Promise<{ templates: BuiltinSoulTemplateWithContent[]; error?: string }> {
    try {
      const directory = this.options.bundledDirectoryCandidates
        .map((candidate) => resolve(candidate))
        .find(existsSync)
      if (!directory) throw new Error('Bundled SOUL templates are unavailable')
      const result = await Promise.all(
        templates.map(async (template) => ({
          ...template,
          tags: [...template.tags],
          content: await readFile(resolve(directory, basename(template.filename)), 'utf8')
        }))
      )
      return { templates: result }
    } catch (error) {
      return { templates: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  targetPaths(projectRootPath?: string): {
    global: { available: true; path: string }
    project: { available: boolean; path: string | null }
  } {
    const root = projectRootPath?.trim()
    const projectPath = root ? resolve(root, '.agents', 'SOUL.md') : null
    return {
      global: {
        available: true,
        path: resolve(
          this.options.olaDataRoot ?? resolve(this.options.homeDirectory, '.ola'),
          'SOUL.md'
        )
      },
      project: { available: Boolean(projectPath), path: projectPath }
    }
  }

  async install(input: {
    content?: string
    target?: 'global' | 'project'
    projectRootPath?: string
  }): Promise<{ success: boolean; path?: string; error?: string }> {
    const content = input.content ?? ''
    if (!content.trim()) return { success: false, error: 'SOUL content is empty' }
    const targets = this.targetPaths(input.projectRootPath)
    const path = input.target === 'project' ? targets.project.path : targets.global.path
    if (!path) return { success: false, error: 'Project SOUL target is unavailable' }
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, 'utf8')
      return { success: true, path }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
