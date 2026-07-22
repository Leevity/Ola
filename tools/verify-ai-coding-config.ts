import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { sanitizeAiCodingConfig, sanitizeAiCodingConfigs } from '../src/shared/ai-coding-config'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const config = sanitizeAiCodingConfig({
  id: 'codex-main',
  name: 'Codex Main',
  tool: 'codex',
  providerId: 'provider-1',
  modelId: 'model-1',
  permissionMode: 'approve-edits',
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
  apiKey: 'must-not-be-copied'
})
assert(config, 'valid AI Coding config was rejected')
assert(!('apiKey' in config), 'AI Coding config copied a Provider API key')
assert(
  sanitizeAiCodingConfig({ ...config, permissionMode: 'unknown' }) === null,
  'unknown permission mode was accepted'
)
const deduped = sanitizeAiCodingConfigs([config, { ...config, name: 'Latest' }])
assert(deduped.length === 1 && deduped[0].name === 'Latest', 'config IDs were not deduplicated')

const panelSource = await readFile(
  path.join(process.cwd(), 'src/renderer/src/components/settings/AiCodingConfigPanel.tsx'),
  'utf8'
)
assert(panelSource.includes("'••••••••'"), 'credential masking is missing')
assert(!panelSource.includes('provider.apiKey}'), 'Provider key is rendered in settings')

console.log('ai-coding-config verification passed')
