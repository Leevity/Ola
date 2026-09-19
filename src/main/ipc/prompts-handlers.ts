import { registerMessagePackHandler } from './messagepack-handler'
import { join } from 'node:path'
import { olaDataRoot } from '../lib/ola-data-root'
import { getBundledResourceDirCandidates } from '../resources/bundled-resources'
import { PromptCatalog } from '../user-content/prompt-catalog'

export function registerPromptsHandlers(): void {
  const catalog = new PromptCatalog({
    userDirectory: join(olaDataRoot(), 'prompts'),
    bundledDirectoryCandidates: getBundledResourceDirCandidates('prompts')
  })
  void catalog.ensure()

  registerMessagePackHandler<undefined, string[]>('prompts:list', async () => {
    return await catalog.list()
  })

  registerMessagePackHandler<{ name: string }, { content: string } | { error: string }>(
    'prompts:load',
    async (args) => {
      return await catalog.load(args.name)
    }
  )
}
