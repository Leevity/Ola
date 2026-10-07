import { describe, expect, it } from 'vitest'
import { createExecutionRetryDraft } from '../../src/renderer/src/lib/execution-retry-draft'

describe('execution retry draft preparation', () => {
  it('copies the exact original prompt as an editable draft without attachments', () => {
    expect(createExecutionRetryDraft('  Please review the project.\n  ', null)).toEqual({
      text: '  Please review the project.\n  ',
      images: [],
      skill: null,
      selectedFiles: []
    })
  })

  it('preserves an existing draft and rejects an empty original prompt', () => {
    const existing = { text: 'unsent work', images: [], skill: null, selectedFiles: [] }
    expect(createExecutionRetryDraft('retry this', existing)).toBeNull()
    expect(createExecutionRetryDraft('  ', null)).toBeNull()
  })
})
