import { randomUUID } from 'node:crypto'
import {
  sanitizeAiCodingConfig,
  sanitizeAiCodingConfigs,
  type AiCodingConfig
} from '../../shared/ai-coding-config'
import { initializeSettingsCache, setSettingsValue } from './settings-handlers'
import { registerMessagePackHandler } from './messagepack-handler'
import { readConfig } from './secure-key-store'
import { createTerminalSession } from './terminal-handlers'
import { buildShellEnvironment } from './shell-environment'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const STORAGE_KEY = 'ola-ai-coding-configs'
const execFileAsync = promisify(execFile)

function decodeState(value: unknown): Record<string, unknown> {
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return {}
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const record = parsed as Record<string, unknown>
  return record.state && typeof record.state === 'object' && !Array.isArray(record.state)
    ? (record.state as Record<string, unknown>)
    : record
}

export async function readAiCodingConfigs(): Promise<AiCodingConfig[]> {
  const settings = await initializeSettingsCache()
  return sanitizeAiCodingConfigs(settings[STORAGE_KEY])
}

async function writeConfigs(configs: AiCodingConfig[]): Promise<void> {
  await setSettingsValue(STORAGE_KEY, configs)
}

export function registerAiCodingHandlers(): void {
  registerMessagePackHandler<undefined>('ai-coding:configs-list', async () => ({
    success: true,
    configs: await readAiCodingConfigs()
  }))

  registerMessagePackHandler<Partial<AiCodingConfig>>('ai-coding:configs-save', async (input) => {
    const now = Date.now()
    const configs = await readAiCodingConfigs()
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
    const configs = await readAiCodingConfigs()
    const next = configs.filter((config) => config.id !== id)
    await writeConfigs(next)
    return { success: true, deleted: next.length !== configs.length }
  })

  registerMessagePackHandler<{ configId: string; cwd: string; projectId?: string | null }>(
    'ai-coding:terminal-launch',
    async (input, event) => {
      const config = (await readAiCodingConfigs()).find(
        (candidate) => candidate.id === input.configId && candidate.enabled
      )
      if (!config) return { success: false, error: 'config_unavailable' }

      const root = await readConfig()
      const providerState = decodeState(root['ola-providers'])
      const providers = Array.isArray(providerState.providers)
        ? (providerState.providers as Array<Record<string, unknown>>)
        : []
      const provider = providers.find((candidate) => candidate.id === config.providerId)
      if (!provider || provider.enabled === false) {
        return { success: false, error: 'provider_unavailable' }
      }
      const models = Array.isArray(provider.models) ? provider.models : []
      const model = models.find(
        (candidate) =>
          candidate &&
          typeof candidate === 'object' &&
          (candidate as Record<string, unknown>).id === config.modelId &&
          (candidate as Record<string, unknown>).enabled !== false
      )
      if (!model) return { success: false, error: 'model_unavailable' }

      const cli = config.tool === 'claude-code' ? 'claude' : 'codex'
      const shellEnvironment = buildShellEnvironment()
      try {
        await execFileAsync(cli, ['--version'], { env: shellEnvironment, timeout: 10_000 })
      } catch {
        return { success: false, error: 'cli_missing', cli }
      }

      const apiKey =
        typeof provider.apiKey === 'string' && provider.apiKey.trim()
          ? provider.apiKey
          : typeof (provider.oauth as Record<string, unknown> | undefined)?.accessToken === 'string'
            ? String((provider.oauth as Record<string, unknown>).accessToken)
            : ''
      if (!apiKey && provider.requiresApiKey !== false) {
        return { success: false, error: 'credential_unavailable' }
      }
      const baseUrl = typeof provider.baseUrl === 'string' ? provider.baseUrl : ''
      const extraEnvironment: Record<string, string> =
        config.tool === 'claude-code'
          ? {
              ANTHROPIC_API_KEY: apiKey,
              ANTHROPIC_AUTH_TOKEN: apiKey,
              ANTHROPIC_BASE_URL: baseUrl,
              ANTHROPIC_MODEL: config.modelId
            }
          : {
              OPENAI_API_KEY: apiKey,
              CODEX_API_KEY: apiKey,
              OPENAI_BASE_URL: baseUrl,
              CODEX_MODEL: config.modelId
            }
      const command =
        config.tool === 'claude-code'
          ? config.permissionMode === 'full-access'
            ? 'claude --dangerously-skip-permissions'
            : config.permissionMode === 'approve-edits'
              ? 'claude --permission-mode acceptEdits'
              : config.permissionMode === 'read-only'
                ? 'claude --permission-mode plan'
                : 'claude'
          : config.permissionMode === 'full-access'
            ? 'codex --dangerously-bypass-approvals-and-sandbox'
            : config.permissionMode === 'approve-edits'
              ? 'codex --ask-for-approval on-request'
              : config.permissionMode === 'read-only'
                ? 'codex --sandbox read-only'
                : 'codex'
      const terminal = await createTerminalSession(
        { cwd: input.cwd, title: config.name, command },
        event.sender,
        extraEnvironment
      )
      return terminal.error
        ? { success: false, error: terminal.error }
        : { success: true, terminal }
    }
  )
}
