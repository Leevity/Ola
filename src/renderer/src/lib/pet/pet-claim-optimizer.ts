import { nanoid } from 'nanoid'
import type { AIModelConfig, AIProvider, ProviderConfig, UnifiedMessage } from '../api/types'
import { runSidecarTextRequest } from '../ipc/agent-bridge'
import { isProviderAvailableForModelSelection, useProviderStore } from '../../stores/provider-store'

const PET_CLAIM_OPTIMIZER_SYSTEM_PROMPT = `You are Ola's companion designer.

Turn the user's rough idea into a usable desktop companion profile and image prompt.

Return strict JSON only:
{
  "name": "short companion name",
  "description": "concise user-facing description",
  "persona": "system prompt for the companion",
  "imagePrompt": "professional image-generation prompt"
}

Rules:
- Keep the user's original language.
- The companion is a small desktop buddy in Ola, not a full assistant.
- The name should be short, warm, and easy to remember.
- The description should include appearance, personality, and companionship style.
- The persona must tell the companion to reply briefly, warmly, with a little individuality, using the user's language.
- The imagePrompt should be production-ready for image generation: transparent background, centered full-body sprite, consistent character design, no text, no watermark, square canvas.
- If the user gives an existing name, preserve it unless it is clearly placeholder text.
- Do not mention APIs, tokens, model names, or implementation details.`

export interface PetClaimOptimizationResult {
  name: string
  description: string
  persona: string
  imagePrompt: string
}

export function pickPetClaimTextProvider(): {
  provider: AIProvider
  model: AIModelConfig
  config: ProviderConfig
} | null {
  const store = useProviderStore.getState()
  const enabledProviders = store.providers.filter(
    (provider) =>
      isProviderAvailableForModelSelection(provider) &&
      provider.models.some((model) => model.enabled && (model.category ?? 'chat') === 'chat')
  )

  const provider =
    enabledProviders.find((candidate) =>
      candidate.models.some(
        (model) =>
          model.enabled &&
          (model.category ?? 'chat') === 'chat' &&
          (model.id.includes('haiku') ||
            model.id.includes('4o-mini') ||
            model.id.includes('gpt-4o-mini'))
      )
    ) ?? enabledProviders[0]

  if (!provider) return null

  const model =
    provider.models.find(
      (candidate) =>
        candidate.enabled &&
        (candidate.category ?? 'chat') === 'chat' &&
        (candidate.id.includes('haiku') ||
          candidate.id.includes('4o-mini') ||
          candidate.id.includes('gpt-4o-mini'))
    ) ??
    provider.models.find(
      (candidate) => candidate.enabled && (candidate.category ?? 'chat') === 'chat'
    )

  if (!model) return null

  const config = store.getProviderConfigById(provider.id, model.id)
  if (!config) return null

  return { provider, model, config }
}

export async function optimizePetClaimDraft(args: {
  providerConfig: ProviderConfig
  name?: string
  description: string
  signal?: AbortSignal
}): Promise<PetClaimOptimizationResult> {
  const messages: UnifiedMessage[] = [
    {
      id: nanoid(),
      role: 'user',
      content: [
        'Create an Ola desktop companion profile from this rough input.',
        args.name?.trim() ? `Existing name:\n${args.name.trim()}` : null,
        `Rough idea:\n${args.description.trim()}`
      ]
        .filter(Boolean)
        .join('\n\n'),
      createdAt: Date.now()
    }
  ]

  const output = await runSidecarTextRequest({
    messages,
    provider: {
      ...args.providerConfig,
      systemPrompt: PET_CLAIM_OPTIMIZER_SYSTEM_PROMPT,
      temperature: 0.4,
      maxTokens: 1200
    },
    signal: args.signal
  })

  return parsePetClaimOptimizationResult(output)
}

function parsePetClaimOptimizationResult(raw: string): PetClaimOptimizationResult {
  const trimmed = raw.trim()
  const jsonText =
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ??
    trimmed.match(/\{[\s\S]*\}/)?.[0]?.trim() ??
    trimmed
  const parsed = JSON.parse(jsonText) as Partial<PetClaimOptimizationResult>

  const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
  const description = typeof parsed.description === 'string' ? parsed.description.trim() : ''
  const persona = typeof parsed.persona === 'string' ? parsed.persona.trim() : ''
  const imagePrompt = typeof parsed.imagePrompt === 'string' ? parsed.imagePrompt.trim() : ''

  if (!name || !description || !persona || !imagePrompt) {
    throw new Error('Pet optimization returned incomplete JSON')
  }

  return { name, description, persona, imagePrompt }
}
