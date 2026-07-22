export type AiCodingTool = 'claude-code' | 'codex'
export type AiCodingPermissionMode = 'standard' | 'approve-edits' | 'read-only' | 'full-access'

export interface AiCodingConfig {
  id: string
  name: string
  tool: AiCodingTool
  providerId: string
  modelId: string
  permissionMode: AiCodingPermissionMode
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export const AI_CODING_TOOLS: AiCodingTool[] = ['claude-code', 'codex']
export const AI_CODING_PERMISSION_MODES: AiCodingPermissionMode[] = [
  'standard',
  'approve-edits',
  'read-only',
  'full-access'
]

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function sanitizeAiCodingConfig(value: unknown): AiCodingConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<AiCodingConfig>
  const id = text(candidate.id)
  const name = text(candidate.name)
  const providerId = text(candidate.providerId)
  const modelId = text(candidate.modelId)
  if (!id || !name || !providerId || !modelId) return null
  if (!AI_CODING_TOOLS.includes(candidate.tool as AiCodingTool)) return null
  if (!AI_CODING_PERMISSION_MODES.includes(candidate.permissionMode as AiCodingPermissionMode)) {
    return null
  }
  const now = Date.now()
  return {
    id,
    name,
    tool: candidate.tool as AiCodingTool,
    providerId,
    modelId,
    permissionMode: candidate.permissionMode as AiCodingPermissionMode,
    enabled: candidate.enabled !== false,
    createdAt: Number.isFinite(candidate.createdAt) ? Number(candidate.createdAt) : now,
    updatedAt: Number.isFinite(candidate.updatedAt) ? Number(candidate.updatedAt) : now
  }
}

export function sanitizeAiCodingConfigs(value: unknown): AiCodingConfig[] {
  if (!Array.isArray(value)) return []
  const unique = new Map<string, AiCodingConfig>()
  for (const item of value) {
    const config = sanitizeAiCodingConfig(item)
    if (config) unique.set(config.id, config)
  }
  return [...unique.values()]
}
