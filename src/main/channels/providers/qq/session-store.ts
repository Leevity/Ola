import { QqSessionFileStore } from './session-file-store'

export interface SessionState {
  sessionId: string | null
  lastSeq: number | null
  lastConnectedAt: number
  intentLevelIndex: number
  accountId: string
  savedAt: number
}

const SAVE_THROTTLE_MS = 1000
const fileStore = new QqSessionFileStore()

const throttleState = new Map<
  string,
  {
    pendingState: SessionState | null
    lastSaveTime: number
    throttleTimer: ReturnType<typeof setTimeout> | null
  }
>()

export async function loadSession(accountId: string): Promise<SessionState | null> {
  try {
    return await fileStore.load(accountId)
  } catch (error) {
    console.error(`[qq-bot:session] Failed to load session for ${accountId}:`, error)
    return null
  }
}

export function saveSession(state: SessionState): void {
  const { accountId } = state
  let throttle = throttleState.get(accountId)

  if (!throttle) {
    throttle = {
      pendingState: null,
      lastSaveTime: 0,
      throttleTimer: null
    }
    throttleState.set(accountId, throttle)
  }

  const now = Date.now()
  const timeSinceLastSave = now - throttle.lastSaveTime

  if (timeSinceLastSave >= SAVE_THROTTLE_MS) {
    void doSaveSession(state)
    throttle.lastSaveTime = now
    throttle.pendingState = null

    if (throttle.throttleTimer) {
      clearTimeout(throttle.throttleTimer)
      throttle.throttleTimer = null
    }

    return
  }

  throttle.pendingState = state

  if (!throttle.throttleTimer) {
    const delay = SAVE_THROTTLE_MS - timeSinceLastSave
    throttle.throttleTimer = setTimeout(() => {
      const current = throttleState.get(accountId)
      if (current?.pendingState) {
        void doSaveSession(current.pendingState)
        current.lastSaveTime = Date.now()
        current.pendingState = null
      }
      if (current) {
        current.throttleTimer = null
      }
    }, delay)
  }
}

async function doSaveSession(state: SessionState): Promise<void> {
  try {
    await fileStore.save(state)
  } catch (error) {
    console.error(`[qq-bot:session] Failed to save session for ${state.accountId}:`, error)
  }
}

export async function clearSession(accountId: string): Promise<void> {
  const throttle = throttleState.get(accountId)

  if (throttle?.throttleTimer) {
    clearTimeout(throttle.throttleTimer)
  }
  throttleState.delete(accountId)

  try {
    await fileStore.clear(accountId)
  } catch (error) {
    console.error(`[qq-bot:session] Failed to clear session for ${accountId}:`, error)
  }
}
