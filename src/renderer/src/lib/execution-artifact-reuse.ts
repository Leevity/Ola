import type { InputDraftValue } from '@renderer/stores/input-draft-store'
import { ensureSelectedFile } from '@renderer/lib/select-file-editor'
import { createSelectFileTag } from '@renderer/lib/select-file-tags'

function pathKey(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  return normalized.startsWith('/') ? normalized : normalized.toLowerCase()
}

export function addArtifactFileToDraft(
  current: InputDraftValue | null,
  filePath: string,
  workingFolder?: string
): { draft: InputDraftValue; added: boolean } {
  const base: InputDraftValue = current ?? {
    text: '',
    images: [],
    skill: null,
    selectedFiles: []
  }
  if (base.selectedFiles.some((file) => pathKey(file.previewPath) === pathKey(filePath))) {
    return { draft: base, added: false }
  }

  const ensured = ensureSelectedFile(base.selectedFiles, filePath, workingFolder)
  if (!ensured.file) throw new Error('Invalid artifact file path')
  const reference = createSelectFileTag(ensured.file.sendPath)
  if (!reference) throw new Error('Invalid artifact file reference')

  return {
    draft: {
      ...base,
      text: base.text
        ? `${base.text}${base.text.endsWith('\n') ? '' : '\n'}${reference}`
        : reference,
      selectedFiles: ensured.files
    },
    added: true
  }
}

export function addArtifactRemoteFileToDraft(
  current: InputDraftValue | null,
  filePath: string
): { draft: InputDraftValue; added: boolean } {
  if (!filePath.startsWith('/') || filePath.includes('\0') || filePath.split('/').includes('..'))
    throw new Error('Invalid remote artifact path')
  return addArtifactFileToDraft(current, filePath)
}

/** A link is a reviewed text reference; reuse never fetches the remote resource. */
export function addArtifactLinkToDraft(
  current: InputDraftValue | null,
  urlText: string
): { draft: InputDraftValue; added: boolean } {
  const url = new URL(urlText)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Invalid artifact link')
  const base = current ?? { text: '', images: [], skill: null, selectedFiles: [] }
  if (base.text.split(/\s+/).includes(url.href)) return { draft: base, added: false }
  return {
    draft: {
      ...base,
      text: `${base.text}${base.text && !base.text.endsWith('\n') ? '\n' : ''}${url.href}`
    },
    added: true
  }
}
