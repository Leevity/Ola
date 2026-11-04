import type { SelectedFileReference } from '@renderer/lib/api/types'

/** How a user turn entered the agent loop. */
export type MessageSource = 'team' | 'queued' | 'continue' | 'quoted'

export interface SendMessageOptions {
  /** Business TaskItem explicitly chosen by the user for this run. */
  businessTaskId?: string
  longRunningMode?: boolean
  clearCompletedTasksOnTurnStart?: boolean
  skipPendingPlanRevision?: boolean
  skipAutoContextCompression?: boolean
  enablePlanMode?: boolean
  goalObjective?: string
  selectedFileReferences?: SelectedFileReference[]
  /**
   * When set, the user message has already been appended to the transcript
   * (e.g. via the quote action) and sendMessage should run the agent loop
   * against it without inserting a duplicate user message.
   */
  preRenderedUserMessageId?: string
  imageEdit?: {
    maskDataUrl?: string
  }
}
