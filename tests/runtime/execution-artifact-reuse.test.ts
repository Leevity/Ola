import { describe, expect, it } from 'vitest'
import {
  addArtifactRemoteFileToDraft,
  addArtifactFileToDraft,
  addArtifactLinkToDraft
} from '../../src/renderer/src/lib/execution-artifact-reuse'

describe('execution artifact reuse', () => {
  it('preserves SSH path case and rejects traversal or relative remote paths', () => {
    const first = addArtifactRemoteFileToDraft(null, '/srv/Report.md')
    expect(addArtifactRemoteFileToDraft(first.draft, '/srv/Report.md').added).toBe(false)
    expect(addArtifactRemoteFileToDraft(first.draft, '/srv/report.md').added).toBe(true)
    expect(() => addArtifactRemoteFileToDraft(null, '/srv/../secret')).toThrow()
    expect(() => addArtifactRemoteFileToDraft(null, 'relative.md')).toThrow()
  })
  it('appends a reviewed link without replacing text, files, images or skill', () => {
    const base = addArtifactFileToDraft(null, 'C:/project/report.md').draft
    base.skill = 'review'
    const first = addArtifactLinkToDraft(base, 'https://example.com/report')
    expect(first.draft.text).toBe(`${base.text}\nhttps://example.com/report`)
    expect(first.draft.selectedFiles).toEqual(base.selectedFiles)
    expect(first.draft.images).toEqual(base.images)
    expect(first.draft.skill).toBe('review')
    expect(addArtifactLinkToDraft(first.draft, 'https://example.com/report').added).toBe(false)
    expect(() => addArtifactLinkToDraft(base, 'file:///C:/secret')).toThrow('Invalid artifact link')
    expect(() => addArtifactLinkToDraft(base, 'https://user:secret@example.com')).toThrow(
      'Invalid artifact link'
    )
  })
  it('preserves an existing draft and appends a file reference for the next task', () => {
    const first = addArtifactFileToDraft(
      { text: 'Summarize this', images: [], skill: 'review', selectedFiles: [] },
      'C:\\project\\report.md',
      'C:\\project'
    )

    expect(first.added).toBe(true)
    expect(first.draft.text).toBe('Summarize this\n<select-file>report.md</select-file>')
    expect(first.draft.selectedFiles[0]).toMatchObject({
      sendPath: 'report.md',
      previewPath: 'C:/project/report.md'
    })
    expect(first.draft.skill).toBe('review')
  })

  it('does not add the same result twice', () => {
    const first = addArtifactFileToDraft(null, 'C:\\project\\report.md', 'C:\\project')
    const second = addArtifactFileToDraft(first.draft, 'c:/PROJECT/report.md', 'C:\\project')

    expect(second.added).toBe(false)
    expect(second.draft).toEqual(first.draft)
  })

  it('rejects an empty path', () => {
    expect(() => addArtifactFileToDraft(null, '  ')).toThrow('Invalid artifact file path')
  })
})
