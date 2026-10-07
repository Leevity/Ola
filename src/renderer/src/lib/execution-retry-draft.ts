import { hasInputDraftContent, type InputDraftContent } from '../../../shared/input-draft-types'

/** Returns a reviewed retry draft only when the destination session has no unsent content. */
export function createExecutionRetryDraft(
  originalPrompt: string,
  existingDraft: InputDraftContent | null
): InputDraftContent | null {
  if (!originalPrompt.trim() || (existingDraft && hasInputDraftContent(existingDraft))) return null
  return {
    text: originalPrompt,
    images: [],
    skill: null,
    selectedFiles: []
  }
}
