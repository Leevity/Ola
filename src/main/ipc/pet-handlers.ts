import { app, BrowserWindow, powerMonitor, screen } from 'electron'
import { basename, join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'fs/promises'
import { registerMessagePackHandler } from './messagepack-handler'
import { safeSendMessagePackToAllWindows } from '../window-ipc'
import { decodePersistedStoreState, readSettings, setSettingsValue } from './settings-handlers'

const PET_WINDOW_WIDTH = 480
const PET_WINDOW_HEIGHT = 380
const PET_ENABLED_SETTINGS_KEY = 'petDesktopEnabled'
const PET_EXP_SETTINGS_KEY = 'ola-pet-exp'
const PET_EXP_LOG_LIMIT = 100

/** ~/.ola/pets — directory shared by all renderer processes. */
async function getPetsDirMain(): Promise<string> {
  return join(homedir(), '.ola', 'pets')
}

async function safeMkdir(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true })
  } catch {
    // EEXIST or permission denied — we tolerate both. Per-pet writes never
    // depend on the directory existing ahead of time.
  }
}

async function safeReadJson(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function safeWriteJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), 'utf8')
}

type PetExpAddArgs = {
  id: string
  at: number
  model: string
  tokens: number
  exp: number
}

type PetWindowDeps = {
  loadRendererWindow: (window: BrowserWindow, searchParams?: URLSearchParams) => Promise<void>
  showMainWindow: () => void
}

type PetTtsStreamArgs = {
  requestId: string
  provider?: {
    baseUrl?: string
    apiKey?: string
    model?: string
    requestOverrides?: { headers?: Record<string, string>; body?: Record<string, unknown> }
  }
  input?: string
  voice?: string
  instruction?: string
  chatStyle?: string
}

const petTtsStreams = new Map<string, AbortController>()

async function streamChatTts(
  args: PetTtsStreamArgs,
  signal: AbortSignal,
  onChunk: (base64Pcm: string) => void
): Promise<void> {
  const provider = args.provider!
  const baseUrl = (provider.baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '')
  const input = args.input!.trim()
  const instruction = args.instruction?.trim()

  // Same two message shapes as the native worker's non-streaming path:
  // MiMo speaks the assistant message verbatim; OpenAI audio models get a
  // read-aloud instruction in a user message.
  const messages: Array<{ role: string; content: string }> = []
  if (args.chatStyle === 'instruct') {
    const directive = instruction
      ? `Read the following text aloud exactly as written. Do not add, omit or change anything. Speaking style: ${instruction}`
      : 'Read the following text aloud exactly as written. Do not add, omit or change anything.'
    messages.push({ role: 'user', content: `${directive}\n\n${input}` })
  } else {
    if (instruction) messages.push({ role: 'user', content: instruction })
    messages.push({ role: 'assistant', content: input })
  }

  const body: Record<string, unknown> = {
    model: provider.model,
    modalities: ['text', 'audio'],
    messages,
    audio: args.voice ? { format: 'pcm16', voice: args.voice } : { format: 'pcm16' },
    stream: true,
    ...(provider.requestOverrides?.body ?? {})
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey ?? ''}`,
      ...(provider.requestOverrides?.headers ?? {})
    },
    body: JSON.stringify(body),
    signal
  })
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    throw new Error(`TTS stream failed HTTP ${response.status}: ${text.slice(0, 300)}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{ delta?: { audio?: { data?: string } } }>
        }
        const data = json.choices?.[0]?.delta?.audio?.data
        if (typeof data === 'string' && data.length > 0) onChunk(data)
      } catch {
        // keep-alives / non-JSON lines
      }
    }
  }
}

let petWindow: BrowserWindow | null = null
let deps: PetWindowDeps | null = null
let opening = false

export function isPetWindowOpen(): boolean {
  return !!petWindow && !petWindow.isDestroyed()
}

export function isPetEnabled(): boolean {
  // Default off: low-end hardware shouldn't pay for a floating sprite
  // until the user opts in via the "show desktop companions" switch.
  return readSettings()[PET_ENABLED_SETTINGS_KEY] === true
}

function broadcastPetWindowChanged(): void {
  safeSendMessagePackToAllWindows('pet-window:changed', { open: isPetWindowOpen() })
}

async function persistPetEnabled(enabled: boolean): Promise<void> {
  try {
    await setSettingsValue(PET_ENABLED_SETTINGS_KEY, enabled ? true : undefined)
  } catch (error) {
    console.error('[Pet] Failed to persist pet enabled state:', error)
  }
}

export async function openPetWindow(): Promise<void> {
  if (!deps || opening) return

  if (isPetWindowOpen()) {
    petWindow?.showInactive()
    return
  }

  opening = true
  const workArea = screen.getPrimaryDisplay().workArea
  const height = Math.min(PET_WINDOW_HEIGHT, workArea.height)
  const width = Math.min(PET_WINDOW_WIDTH, workArea.width)

  const window = new BrowserWindow({
    x: workArea.x + Math.max(0, Math.floor((workArea.width - width) / 2)),
    y: workArea.y + workArea.height - height,
    width,
    height,
    show: true,
    transparent: false,
    backgroundColor: '#f8fafc',
    frame: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    alwaysOnTop: true,
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    hasShadow: true,
    focusable: true,
    title: 'Ola Desktop Companion',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  petWindow = window
  window.setAlwaysOnTop(true, 'floating')
  if (process.platform === 'darwin') {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  window.on('ready-to-show', () => {
    if (!window.isDestroyed()) {
      window.show()
      window.focus()
    }
  })

  window.on('closed', () => {
    if (petWindow === window) {
      petWindow = null
    }
    broadcastPetWindowChanged()
  })

  try {
    await deps.loadRendererWindow(window, new URLSearchParams({ appView: 'pet' }))
    broadcastPetWindowChanged()
  } catch (error) {
    petWindow = null
    if (!window.isDestroyed()) {
      window.destroy()
    }
    console.error('[Pet] Failed to open pet window:', error)
  } finally {
    opening = false
  }
}

export function closePetWindow(): void {
  if (!isPetWindowOpen()) return
  const window = petWindow
  petWindow = null
  window?.destroy()
  broadcastPetWindowChanged()
}

export async function togglePetWindow(): Promise<void> {
  if (isPetWindowOpen()) {
    closePetWindow()
    await persistPetEnabled(false)
    return
  }
  await openPetWindow()
  await persistPetEnabled(true)
}

export async function openPetWindowOnStartupIfEnabled(): Promise<void> {
  if (isPetEnabled()) {
    await openPetWindow()
  }
}

function getBundledPetDirCandidates(): string[] {
  if (!app.isPackaged) {
    return [join(app.getAppPath(), 'resources', 'pets')]
  }
  return [
    join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'pets'),
    join(process.resourcesPath, 'resources', 'pets')
  ]
}

/**
 * Install/repair bundled pets into ~/.ola/pets. File-level
 * fill-missing semantics: files the user already has are never overwritten,
 * but files absent from an installed pet (older app version, interrupted
 * install) are copied in. (The default capybara ships in renderer assets and
 * is not part of this.)
 */
export async function installBuiltinPets(): Promise<void> {
  try {
    const targetRoot = join(homedir(), '.ola', 'pets')
    await mkdir(targetRoot, { recursive: true })

    for (const candidate of getBundledPetDirCandidates()) {
      let entries: string[]
      try {
        entries = await readdir(candidate)
      } catch {
        continue
      }
      for (const entry of entries) {
        const source = join(candidate, entry)
        try {
          if (!(await stat(source)).isDirectory()) continue
        } catch {
          continue
        }
        const targetDir = join(targetRoot, entry)
        await mkdir(targetDir, { recursive: true })

        let installed = 0
        for (const file of await readdir(source)) {
          const sourceFile = join(source, file)
          try {
            if (!(await stat(sourceFile)).isFile()) continue
          } catch {
            continue
          }
          const targetFile = join(targetDir, file)
          try {
            await stat(targetFile)
            continue // user's copy wins
          } catch {
            // missing: fill in
          }
          await cp(sourceFile, targetFile)
          installed++
        }
        if (installed > 0) {
          console.log(`[Pet] Installed built-in pet files: ${entry} (+${installed})`)
        }
      }
      break // first existing candidate wins
    }
  } catch (error) {
    console.error('[Pet] Failed to install built-in pets:', error)
  }
}

export function registerPetHandlers(petDeps: PetWindowDeps): void {
  deps = petDeps

  registerMessagePackHandler<void>('pet-window:open', async () => {
    console.log('[Pet] pet-window:open invoked, opening pet window')
    await openPetWindow()
    return { open: isPetWindowOpen() }
  })

  registerMessagePackHandler<void>('pet-window:close', async () => {
    console.log('[Pet] pet-window:close invoked, closing pet window')
    closePetWindow()
    return { open: false }
  })

  registerMessagePackHandler<void>('pet-window:status', () => ({
    open: isPetWindowOpen(),
    enabled: isPetEnabled()
  }))

  registerMessagePackHandler<{ ignore?: boolean }>('pet-window:set-ignore-mouse', (args, event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window !== petWindow || window.isDestroyed()) return
    window.setIgnoreMouseEvents(args?.ignore !== false, { forward: true })
  })

  // The pet window is non-focusable by default; the chat input needs the
  // window to accept keyboard focus while it is open.
  registerMessagePackHandler<{ focusable?: boolean }>('pet-window:set-focusable', (args, event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window !== petWindow || window.isDestroyed()) return
    const focusable = args?.focusable === true
    if (focusable) {
      window.setFocusable(true)
      // show() (not showInactive) is what makes a previously non-focusable
      // window become the key window on macOS; re-assert always-on-top after
      // the focusable toggle.
      window.show()
      window.focus()
      window.setAlwaysOnTop(true, 'floating')
    } else {
      // Hand key status back before the toggle; setFocusable resets the
      // window level on macOS, which blinks unless always-on-top is
      // re-asserted and the window is re-ordered without taking focus.
      window.blur()
      window.setFocusable(false)
      window.setAlwaysOnTop(true, 'floating')
      window.showInactive()
    }
  })

  // Seconds since the last user input, for the pet's doze/welcome-back
  // behavior when the user steps away from the computer.
  registerMessagePackHandler<void>('pet-window:idle-seconds', () => {
    return powerMonitor.getSystemIdleTime()
  })

  // Streaming chat-audio TTS (MiMo / gpt-4o-audio, stream: true, pcm16):
  // SSE audio deltas are forwarded as 'pet:tts-stream-event' chunks so the
  // renderer can start playback while synthesis is still running. The
  // invoke itself resolves when the stream ends.
  registerMessagePackHandler<PetTtsStreamArgs>('pet:tts-stream', async (args) => {
    const requestId = args?.requestId
    if (!requestId || !args?.provider || !args?.input?.trim()) {
      throw new Error('invalid tts stream request')
    }
    const controller = new AbortController()
    petTtsStreams.set(requestId, controller)
    try {
      await streamChatTts(args, controller.signal, (data) => {
        safeSendMessagePackToAllWindows('pet:tts-stream-event', {
          requestId,
          type: 'chunk',
          data
        })
      })
      return { ok: true }
    } finally {
      petTtsStreams.delete(requestId)
    }
  })

  registerMessagePackHandler<{ requestId?: string }>('pet:tts-cancel', (args) => {
    if (args?.requestId) petTtsStreams.get(args.requestId)?.abort()
  })

  // Cross-window pet state relay: settings window broadcasts skin/profile
  // changes; the pet window (a separate renderer) picks them up live.
  registerMessagePackHandler<{ kind: string; payload?: unknown }>('pet:sync', (args) => {
    safeSendMessagePackToAllWindows('pet:sync-event', args ?? { kind: 'unknown' })
  })

  // From the pet's context menu: focus the main window on the pet studio.
  registerMessagePackHandler<void>('pet:open-studio', () => {
    deps?.showMainWindow()
    safeSendMessagePackToAllWindows('pet:sync-event', { kind: 'open-studio' })
  })

  // Pet experience ledger. The main process is the single writer so that
  // multiple renderer windows recording usage can't clobber each other.
  // `petId` is optional: legacy callers (single-pet world) leave it null and
  // we still maintain a global ledger under `ola-pet-exp` so nothing breaks.
  registerMessagePackHandler<PetExpAddArgs & { petId?: string | null }>(
    'pet:exp-add',
    async (args) => {
      if (!args || typeof args.exp !== 'number' || !Number.isFinite(args.exp) || args.exp <= 0) {
        return { success: false }
      }
      // Per-pet ledger path. We keep a small JSON file under
      // ~/.ola/pets/<id>/exp.json mirroring the legacy structure so any
      // debugging tool that reads the file can still parse it.
      if (args.petId) {
        const dir = `${await getPetsDirMain()}/${args.petId}`
        await safeMkdir(dir)
        const path = `${dir}/exp.json`
        const persisted =
          decodePersistedStoreState<{
            totalExp?: number
            totalTokens?: number
            log?: PetExpAddArgs[]
          }>(await safeReadJson(path)) ?? {}
        const totalExp = Math.round(((persisted.totalExp ?? 0) + args.exp) * 100) / 100
        const totalTokens = (persisted.totalTokens ?? 0) + (args.tokens > 0 ? args.tokens : 0)
        const log = [args, ...(Array.isArray(persisted.log) ? persisted.log : [])].slice(
          0,
          PET_EXP_LOG_LIMIT
        )
        await safeWriteJson(path, { state: { totalExp, totalTokens, log }, version: 0 })
        safeSendMessagePackToAllWindows('pet:sync-event', { kind: 'exp', petId: args.petId })
        return { success: true, totalExp }
      }

      const persisted =
        decodePersistedStoreState<{
          totalExp?: number
          totalTokens?: number
          log?: PetExpAddArgs[]
        }>(readSettings()[PET_EXP_SETTINGS_KEY]) ?? {}
      const totalExp = Math.round(((persisted.totalExp ?? 0) + args.exp) * 100) / 100
      const totalTokens = (persisted.totalTokens ?? 0) + (args.tokens > 0 ? args.tokens : 0)
      const log = [args, ...(Array.isArray(persisted.log) ? persisted.log : [])].slice(
        0,
        PET_EXP_LOG_LIMIT
      )
      await setSettingsValue(
        PET_EXP_SETTINGS_KEY,
        JSON.stringify({ state: { totalExp, totalTokens, log }, version: 0 })
      )
      safeSendMessagePackToAllWindows('pet:sync-event', { kind: 'exp' })
      return { success: true, totalExp }
    }
  )

  // ---------------------------------------------------------------------
  // Multi-pet CRUD IPC. The renderer is the source of truth (zustand
  // persist); the main process mirrors writes for cross-window consistency
  // and broadcasts `pet:sync-event { kind: 'pets' }` so other windows reload.
  // ---------------------------------------------------------------------
  registerMessagePackHandler<{ pet: unknown }>('pet:create', async (args) => {
    if (!args?.pet) return { ok: false, reason: 'invalid' }
    // Forward a benign notification; the renderer's pets-store already has it.
    safeSendMessagePackToAllWindows('pet:sync-event', { kind: 'pets', action: 'create' })
    return { ok: true }
  })

  registerMessagePackHandler<{ id: string; patch: Record<string, unknown> }>(
    'pet:update',
    async (args) => {
      if (!args?.id) return { ok: false, reason: 'invalid' }
      safeSendMessagePackToAllWindows('pet:sync-event', {
        kind: 'pets',
        action: 'update',
        id: args.id
      })
      return { ok: true }
    }
  )

  registerMessagePackHandler<{ id: string }>('pet:archive', async (args) => {
    if (!args?.id) return { ok: false, reason: 'invalid' }
    safeSendMessagePackToAllWindows('pet:sync-event', {
      kind: 'pets',
      action: 'archive',
      id: args.id
    })
    return { ok: true }
  })

  registerMessagePackHandler<{ folderPath?: string }>(
    'pet:import-companion-folder',
    async (args) => {
      const source = args?.folderPath?.trim()
      if (!source) return { ok: false, reason: 'invalid' }
      try {
        const sourceStat = await stat(source)
        if (!sourceStat.isDirectory()) return { ok: false, reason: 'not-directory' }
        const metaRaw = await safeReadJson(join(source, 'pet.json'))
        if (!metaRaw) return { ok: false, reason: 'missing-meta' }
        const meta = JSON.parse(metaRaw) as Record<string, unknown>
        const files = await readdir(source)
        const hasPose = files.some((file) => file.toLowerCase().endsWith('.png'))
        if (!hasPose) return { ok: false, reason: 'missing-pose' }

        const now = Date.now()
        const skinId = `user-${randomUUID().slice(0, 8)}`
        const target = join(await getPetsDirMain(), skinId)
        await cp(source, target, { recursive: true })
        await safeWriteJson(join(target, 'pet.json'), {
          ...meta,
          name:
            typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : basename(source),
          createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : now,
          builtin: false,
          importedFrom: source
        })
        safeSendMessagePackToAllWindows('pet:sync-event', {
          kind: 'skin',
          payload: { skinId, builtin: false, name: meta.name, createdAt: now }
        })
        return {
          ok: true,
          skinId,
          name:
            typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : basename(source),
          subject: typeof meta.subject === 'string' ? meta.subject : ''
        }
      } catch (error) {
        return { ok: false, reason: 'import-error', message: String(error) }
      }
    }
  )

  // Pull the latest persisted pets collection straight from the main
  // process. Renderer windows cache their own copy in zustand, but two
  // windows (settings + pet) can race against each other and one may
  // mount with a stale view. Reading from main here is the source of
  // truth.
  registerMessagePackHandler<void>('pet:collection:get', async () => {
    const settings = readSettings()
    const state = decodePersistedStoreState(settings['ola-pets-v1'])
    return state ? { state } : null
  })

  // ------------ AI generate a single-frame pet sprite ------------
  // One global 5-minute cooldown (per machine, not per provider) — the model
  // can take a while and we don't want users accidentally burning API quota.
  // Persist the timestamp under settings so it survives restarts.
  let lastAiGenAt = 0
  const AI_GEN_COOLDOWN_MS = 5 * 60_000
  const AI_GEN_PROMPT_MAX = 500

  registerMessagePackHandler<{
    prompt: string
    name: string
    providerId?: string
    modelId?: string
  }>('pet:ai-generate-sprite', async (args) => {
    const now = Date.now()
    if (now - lastAiGenAt < AI_GEN_COOLDOWN_MS) {
      return {
        ok: false,
        reason: 'cooldown',
        retryInMs: AI_GEN_COOLDOWN_MS - (now - lastAiGenAt)
      }
    }
    const prompt = (args?.prompt ?? '').trim().slice(0, AI_GEN_PROMPT_MAX)
    const name = (args?.name ?? '').trim().slice(0, 40) || 'AI Pet'
    if (!prompt) return { ok: false, reason: 'empty' }

    // Resolve provider + api key from the provider store. The renderer keeps
    // the master list; here we read it back so the user doesn't have to
    // configure anything twice.
    const providerInfo = await resolveImageProviderConfig(args?.providerId, args?.modelId)
    if (!providerInfo) {
      return { ok: false, reason: 'no-image-provider' }
    }
    const { baseUrl, apiKey, model } = providerInfo

    // Build a transparent-background-friendly prompt and call the images API
    // directly. Two reasons for bypassing the sidecar stream:
    //   1) we only need one PNG, not a streamed conversation;
    //   2) the renderer doesn't have direct API access in this context.
    const fullPrompt =
      `Generate a single transparent-background PNG sprite of a desktop pet character. ${prompt}. ` +
      `Front-facing, centered, soft lighting, no text, no watermark, square aspect ratio, suitable as a small desktop mascot.`

    let base64: string | null = null
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          prompt: fullPrompt,
          n: 1,
          size: '1024x1024',
          response_format: 'b64_json',
          background: 'transparent'
        })
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        // Best-effort cleanup: rollback the cooldown so the user can retry
        // immediately after fixing the model.
        lastAiGenAt = 0
        return {
          ok: false,
          reason: 'model-error',
          status: response.status,
          message: text.slice(0, 300)
        }
      }
      const payload = (await response.json()) as {
        data?: Array<{ b64_json?: string }>
      }
      base64 = payload.data?.[0]?.b64_json ?? null
    } catch (error) {
      lastAiGenAt = 0
      console.error('[Pet] AI generate failed:', error)
      return { ok: false, reason: 'model-error', message: String(error) }
    }

    if (!base64) {
      lastAiGenAt = 0
      return { ok: false, reason: 'no-image' }
    }

    lastAiGenAt = now
    const skinId = `user-${randomUUID().slice(0, 8)}`
    const dir = `${await getPetsDirMain()}/${skinId}`
    await safeMkdir(dir)
    const pngPath = `${dir}/idle.png`
    await writeFile(pngPath, Buffer.from(base64, 'base64'))
    const meta = {
      name,
      createdAt: now,
      builtin: false,
      kind: 'capy',
      prompt,
      poses: { idle: pngPath }
    }
    await writeFile(`${dir}/pet.json`, JSON.stringify(meta, null, 2), 'utf8')

    safeSendMessagePackToAllWindows('pet:sync-event', {
      kind: 'skin',
      payload: { skinId, builtin: false, name, createdAt: now }
    })

    return {
      ok: true,
      skinId,
      path: pngPath,
      data: base64,
      mediaType: 'image/png',
      name
    }
  })
}

/**
 * Look up the OpenAI-style image endpoint, base URL, API key and model id.
 * Reads from settings.json so the renderer doesn't have to ship secrets
 * across IPC.
 */
async function resolveImageProviderConfig(
  preferredProviderId?: string,
  preferredModelId?: string
): Promise<{ baseUrl: string; apiKey: string; model: string } | null> {
  const all = readSettings()
  const providers = (all.providers ?? []) as Array<{
    id: string
    enabled?: boolean
    apiKey?: string
    baseUrl?: string
    models?: Array<{ id: string; enabled?: boolean; category?: string }>
  }>
  const candidates = providers.filter((p) => p.enabled !== false)
  const provider = preferredProviderId
    ? candidates.find((p) => p.id === preferredProviderId)
    : candidates[0]
  if (!provider) return null
  const models = (provider.models ?? []).filter((m) => m.enabled !== false)
  const model = preferredModelId
    ? models.find((m) => m.id === preferredModelId)
    : (models.find((m) => (m.category ?? 'image') === 'image') ?? models[0])
  if (!model) return null
  return {
    baseUrl: provider.baseUrl ?? 'https://api.openai.com/v1',
    apiKey: provider.apiKey ?? '',
    model: model.id
  }
}
