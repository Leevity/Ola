import type {
  InputDraftContent,
  InputDraftMutationResult,
  InputDraftReadResult
} from '../../../shared/input-draft-types'
import { ipcClient } from './ipc/ipc-client'

function mutationError(result: InputDraftMutationResult, operation: string): void {
  if (!result.success) throw new Error(result.error || `Input draft ${operation} failed`)
}

export async function readInputDraft(key: string): Promise<InputDraftContent | null> {
  const result = (await ipcClient.invoke('input-draft:read', { key })) as InputDraftReadResult
  if (!result.success) throw new Error(result.error || 'Input draft read failed')
  if (!result.draft) return null
  return {
    text: result.draft.text,
    images: result.draft.images.map((image) => ({ ...image })),
    skill: result.draft.skill,
    selectedFiles: result.draft.selectedFiles.map((file) => ({ ...file }))
  }
}

export async function writeInputDraft(key: string, draft: InputDraftContent): Promise<void> {
  const result = (await ipcClient.invoke('input-draft:write', {
    key,
    draft
  })) as InputDraftMutationResult
  mutationError(result, 'write')
}

export async function deleteInputDraft(key: string): Promise<void> {
  const result = (await ipcClient.invoke('input-draft:delete', {
    key
  })) as InputDraftMutationResult
  mutationError(result, 'delete')
}

export async function flushInputDraftWrites(): Promise<void> {
  const result = (await ipcClient.invoke('input-draft:flush', {})) as InputDraftMutationResult
  mutationError(result, 'flush')
}
