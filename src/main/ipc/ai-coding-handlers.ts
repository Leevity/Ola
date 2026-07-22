import { randomUUID } from 'node:crypto'
import {
  sanitizeAiCodingConfig,
  sanitizeAiCodingConfigs,
  type AiCodingConfig
} from '../../shared/ai-coding-config'
import { initializeSettingsCache, setSettingsValue } from './settings-handlers'
import { registerMessagePackHandler } from './messagepack-handler'

const STORAGE_KEY = 'ola-ai-coding-configs'

async function readConfigs(): Promise<AiCodingConfig[]> {
  const settings = await initializeSettingsCache()
  return sanitizeAiCodingConfigs(settings[STORAGE_KEY])
}

async function writeConfigs(configs: AiCodingConfig[]): Promise<void> {
  await setSettingsValue(STORAGE_KEY, configs)
}

export function registerAiCodingHandlers(): void {
  registerMessagePackHandler<undefined>('ai-coding:configs-list', async () => ({
    success: true,
    configs: await readConfigs()
  }))

  registerMessagePackHandler<Partial<AiCodingConfig>>('ai-coding:configs-save', async (input) => {
    const now = Date.now()
    const configs = await readConfigs()
    const existing = input.id ? configs.find((config) => config.id === input.id) : undefined
    const candidate = sanitizeAiCodingConfig({
      ...existing,
      ...input,
      id: input.id || randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    })
    if (!candidate) return { success: false, error: 'invalid_config' }
    const next = configs.filter((config) => config.id !== candidate.id)
    next.push(candidate)
    await writeConfigs(next)
    return { success: true, config: candidate }
  })

  registerMessagePackHandler<{ id: string }>('ai-coding:configs-delete', async ({ id }) => {
    const configs = await readConfigs()
    const next = configs.filter((config) => config.id !== id)
    await writeConfigs(next)
    return { success: true, deleted: next.length !== configs.length }
  })
}
