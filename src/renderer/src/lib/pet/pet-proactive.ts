import { useSettingsStore } from '@renderer/stores/settings-store'
import {
  PET_PROACTIVE_DAILY_CAP,
  getCombinedGrowth,
  getPetLevel,
  getProactiveCountToday,
  isInQuietHours,
  resolvePet,
  usePetsStore
} from '@renderer/stores/pets-store'
import { buildPetSystemPrompt, runPetChat } from './pet-agent'
import {
  appendPetMemories,
  buildMemorySection,
  extractMemoryDirectives,
  loadPetMemories,
  stripMemoryDirectives
} from './pet-memory'

/**
 * LLM-generated proactive speech (event remarks + timed small talk). All of
 * it is gated behind the user's proactive switch, quiet hours, and cooldowns
 * so the pet is lively but never spammy. Every failure is silent — proactive
 * speech must never surface an error dialog on the desktop.
 */

/** Minimum gap between any two LLM remarks (events included). */
const REMARK_MIN_GAP_MS = 10 * 60_000
/** Minimum gap between two timed small-talk initiations. */
const TIMED_MIN_GAP_MS = 2 * 60 * 60_000

let lastRemarkAt = 0

/** Event descriptions handed to the model (it replies in the UI language). */
export const petEvents = {
  levelUp: (level: number) => `你刚刚升级到了 Lv.${level}，很开心，想跟主人报喜。`,
  workDone: (coins: number) => `你刚打工回来，赚到了 ${coins} 金币，有点累但很有成就感。`,
  studyDone: (growth: number) => `你刚放学回来，学到了不少东西（成长 +${growth}）。`,
  bigMeal: (tokens: number) =>
    `主人刚刚用 AI 完成了一个大任务，你一口气吃掉了约 ${tokens.toLocaleString()} 个 token，撑得不行。`
}

function activePetAgent() {
  // Prefer the active pet (multi-pet world); fall back to the legacy global
  // store so anything that hasn't been migrated yet still functions.
  const pet = resolvePet()
  if (pet) return pet.agent
  // Legacy fallback path (will go away once pet-agent-store is removed).
  return null
}

function proactiveAllowed(now: number): boolean {
  const agent = activePetAgent()
  if (!agent) return false
  if (!agent.proactive || !agent.providerId || !agent.modelId) return false
  if (isInQuietHours(new Date(now).getHours(), agent.quietStart, agent.quietEnd)) return false
  return true
}

async function runRemark(event: string, allowTools: boolean): Promise<string | null> {
  const agent = activePetAgent()
  if (!agent || !agent.providerId || !agent.modelId) return null
  try {
    const pet = resolvePet()
    if (!pet) return null
    const memorySection = buildMemorySection(await loadPetMemories(pet.id))
    const persona = buildPetSystemPrompt(agent.systemPrompt, {
      petName: pet.name,
      hunger: pet.hunger,
      cleanliness: pet.cleanliness,
      mood: pet.mood,
      level: getPetLevel(getCombinedGrowth(pet)),
      projectName: agent.projectName,
      projectFolder: agent.projectFolder,
      memorySection
    })
    const language = useSettingsStore.getState().language
    const instruction = [
      '<system-remind>',
      '这不是主人发来的消息，而是一次系统事件提醒。',
      `事件：${event}`,
      `请你以宠物的身份主动对主人说一两句话（不超过 40 字），语气自然，不要提到"系统"或"事件"这些词。使用界面语言（${language}）。只输出要说的话本身。`,
      '</system-remind>'
    ].join('\n')

    const reply = await runPetChat({
      providerId: agent.providerId,
      modelId: agent.modelId,
      persona,
      userText: instruction,
      history: [],
      workingFolder: allowTools ? agent.projectFolder : null,
      petId: pet.id
    })
    const memories = extractMemoryDirectives(reply)
    if (memories.length > 0) void appendPetMemories(memories, pet.id)
    return stripMemoryDirectives(reply) || null
  } catch (error) {
    console.error('[Pet] proactive remark failed:', error)
    return null
  }
}

/**
 * Layer 2 — a short in-character remark about something that just happened
 * (level-up, back from work, big token meal). Returns null when disabled,
 * inside quiet hours, cooling down, or on any error.
 */
export async function runPetEventRemark(event: string): Promise<string | null> {
  const now = Date.now()
  if (!proactiveAllowed(now)) return null
  if (now - lastRemarkAt < REMARK_MIN_GAP_MS) return null
  lastRemarkAt = now
  return runRemark(event, false)
}

/**
 * Layer 3 — timed small talk: the pet reaches out on its own, optionally
 * peeking at the bound project with read-only tools for something concrete
 * to say. Counts against the per-day quota chosen in settings.
 */
export async function runTimedProactiveChat(): Promise<string | null> {
  const now = Date.now()
  if (!proactiveAllowed(now)) return null
  const agent = activePetAgent()
  const pet = resolvePet()
  if (!agent || !pet) return null
  const store = usePetsStore.getState()
  if (getProactiveCountToday(pet) >= PET_PROACTIVE_DAILY_CAP[agent.proactiveFreq]) return null
  if (now - pet.lastProactiveAt < TIMED_MIN_GAP_MS) return null
  if (now - lastRemarkAt < REMARK_MIN_GAP_MS) return null

  store.updatePet(pet.id, {
    proactiveDate: (() => {
      const d = new Date(now)
      const month = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      const today = `${d.getFullYear()}-${month}-${day}`
      return today
    })(),
    proactiveCount: pet.proactiveCount + 1,
    lastProactiveAt: now
  })
  lastRemarkAt = now
  const event = agent.projectFolder
    ? '你有一阵子没和主人说话了，想主动找主人聊两句。你可以先用只读工具快速看一眼绑定项目（最多 2 次工具调用），结合最近的文件聊点具体的；也可以结合你的状态和记忆，说一句自然的开场白或关心的话。'
    : '你有一阵子没和主人说话了，想主动找主人聊两句。结合你的状态和记忆，说一句自然的开场白或关心的话。'
  return runRemark(event, true)
}
