import { create } from 'zustand'
import {
  getCustomInputDraftKey,
  getHomeInputDraftKey,
  getProjectInputDraftKey,
  getSessionInputDraftKey,
  getSubagentInputDraftKey,
  hasInputDraftContent,
  type InputDraftContent
} from '../../../shared/input-draft-types'
import {
  deleteInputDraft,
  flushInputDraftWrites,
  readInputDraft,
  writeInputDraft
} from '@renderer/lib/input-drafts'
import { cloneImageAttachments, type ImageAttachment } from '@renderer/lib/image-attachments'
import type { SelectedFileItem } from '@renderer/lib/select-file-editor'
import { ipcStorage } from '@renderer/lib/ipc/ipc-storage'

export {
  getCustomInputDraftKey,
  getHomeInputDraftKey,
  getProjectInputDraftKey,
  getSessionInputDraftKey,
  getSubagentInputDraftKey,
  hasInputDraftContent
}

export interface InputDraftValue {
  text: string
  images: ImageAttachment[]
  skill: string | null
  selectedFiles: SelectedFileItem[]
}

interface InputDraftStore {
  draftsByKey: Record<string, InputDraftValue>
  hydratedKeys: Record<string, true>
  hydrateDraft: (key: string) => Promise<void>
  getDraft: (key: string) => InputDraftValue | null
  setDraft: (key: string, draft: InputDraftValue | null) => Promise<void>
  removeDraft: (key: string) => Promise<void>
  removeSessionDraft: (sessionId: string) => Promise<void>
  flush: () => Promise<void>
}

function cloneDraft(draft: InputDraftContent): InputDraftValue {
  return {
    text: draft.text,
    images: cloneImageAttachments(draft.images),
    skill: draft.skill,
    selectedFiles: draft.selectedFiles.map((file) => ({ ...file }))
  }
}

const hydratePromises = new Map<string, Promise<void>>()
let legacyMigrationPromise: Promise<void> | null = null

function migrateLegacyKey(key: string): string {
  if (key.startsWith('v1:')) return key
  if (key.startsWith('session:')) return getSessionInputDraftKey(key.slice('session:'.length))
  if (key.startsWith('subagent:')) {
    const [, sessionId = 'unknown', ...agentParts] = key.split(':')
    return getSubagentInputDraftKey(sessionId, agentParts.join(':') || 'overview')
  }
  return getCustomInputDraftKey('legacy', key)
}

async function migrateLegacyDrafts(): Promise<void> {
  if (legacyMigrationPromise) return await legacyMigrationPromise
  legacyMigrationPromise = (async () => {
    const serialized = await ipcStorage.getItem('ola-input-drafts')
    if (!serialized) return
    let parsed: { state?: { draftsByKey?: Record<string, Partial<InputDraftValue>> } }
    try {
      parsed = JSON.parse(serialized) as typeof parsed
    } catch {
      return
    }
    const drafts = parsed.state?.draftsByKey
    if (!drafts || typeof drafts !== 'object') return
    for (const [legacyKey, draft] of Object.entries(drafts)) {
      if (!draft) continue
      const normalized: InputDraftValue = {
        text: typeof draft.text === 'string' ? draft.text : '',
        images: Array.isArray(draft.images) ? draft.images : [],
        skill: typeof draft.skill === 'string' ? draft.skill : null,
        selectedFiles: Array.isArray(draft.selectedFiles) ? draft.selectedFiles : []
      }
      if (!hasInputDraftContent(normalized)) continue
      await writeInputDraft(migrateLegacyKey(legacyKey), cloneDraft(normalized))
    }
    await ipcStorage.removeItem('ola-input-drafts')
  })().catch((error) => {
    legacyMigrationPromise = null
    throw error
  })
  return await legacyMigrationPromise
}

export const useInputDraftStore = create<InputDraftStore>((set, get) => ({
  draftsByKey: {},
  hydratedKeys: {},

  hydrateDraft: async (key) => {
    if (!key || get().hydratedKeys[key]) return
    await migrateLegacyDrafts()
    const existing = hydratePromises.get(key)
    if (existing) return await existing

    const hydration = (async () => {
      const draft = await readInputDraft(key)
      set((state) => ({
        draftsByKey: draft
          ? { ...state.draftsByKey, [key]: cloneDraft(draft) }
          : Object.fromEntries(
              Object.entries(state.draftsByKey).filter(([itemKey]) => itemKey !== key)
            ),
        hydratedKeys: { ...state.hydratedKeys, [key]: true }
      }))
    })().finally(() => hydratePromises.delete(key))
    hydratePromises.set(key, hydration)
    return await hydration
  },

  getDraft: (key) => {
    const draft = get().draftsByKey[key]
    return draft ? cloneDraft(draft) : null
  },

  setDraft: async (key, draft) => {
    if (!key) return
    if (!draft || !hasInputDraftContent(draft)) {
      await get().removeDraft(key)
      return
    }
    const cloned = cloneDraft(draft)
    set((state) => ({
      draftsByKey: { ...state.draftsByKey, [key]: cloned },
      hydratedKeys: { ...state.hydratedKeys, [key]: true }
    }))
    await writeInputDraft(key, cloned)
  },

  removeDraft: async (key) => {
    if (!key) return
    set((state) => ({
      draftsByKey: Object.fromEntries(
        Object.entries(state.draftsByKey).filter(([itemKey]) => itemKey !== key)
      ),
      hydratedKeys: { ...state.hydratedKeys, [key]: true }
    }))
    await deleteInputDraft(key)
  },

  removeSessionDraft: async (sessionId) => {
    await get().removeDraft(getSessionInputDraftKey(sessionId))
  },

  flush: flushInputDraftWrites
}))
