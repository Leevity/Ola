import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  configureInputDraftDirectoryForTests,
  deleteDraft,
  readDraft,
  writeDraft
} from '../src/main/ipc/input-draft-handlers.ts'
import {
  INPUT_DRAFT_MAX_COUNT,
  INPUT_DRAFT_MAX_IMAGE_BYTES,
  INPUT_DRAFT_TTL_MS,
  getCustomInputDraftKey,
  getHomeInputDraftKey,
  getProjectInputDraftKey,
  getSessionInputDraftKey,
  getSubagentInputDraftKey
} from '../src/shared/input-draft-types.ts'
import { isCanonicalContentBlock, normalizeMessageContent } from '../src/shared/content-blocks.ts'

const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'ola-input-drafts-'))
configureInputDraftDirectoryForTests(tempDirectory)

const emptyDraft = {
  text: '',
  images: [],
  skill: null,
  selectedFiles: []
}

try {
  assert.equal(getHomeInputDraftKey(), 'v1:home:default')
  assert.match(getProjectInputDraftKey('project/a'), /^v1:project:/)
  assert.match(getSubagentInputDraftKey('session', 'agent'), /^v1:subagent:/)
  assert.match(getCustomInputDraftKey('plugin', 'composer'), /^v1:custom:/)

  const richKey = getSessionInputDraftKey('rich-session')
  const richDraft = {
    text: '恢复这段文字',
    images: [{ id: 'image-1', dataUrl: 'data:image/png;base64,aGVsbG8=', mediaType: 'image/png' }],
    skill: 'product-design',
    selectedFiles: [
      {
        id: 'file-1',
        name: 'README.md',
        originalPath: '/workspace/README.md',
        sendPath: '/workspace/README.md',
        previewPath: '/workspace/README.md',
        isWorkspaceFile: true
      }
    ]
  }
  assert.equal((await writeDraft({ key: richKey, draft: richDraft })).success, true)
  const restored = await readDraft({ key: richKey })
  assert.equal(restored.success, true)
  assert.deepEqual(
    restored.draft && {
      text: restored.draft.text,
      images: restored.draft.images,
      skill: restored.draft.skill,
      selectedFiles: restored.draft.selectedFiles
    },
    richDraft
  )

  const sessionKeys = Array.from({ length: 8 }, (_, index) =>
    getSessionInputDraftKey(`parallel-${index}`)
  )
  await Promise.all(
    sessionKeys.map((key, index) =>
      writeDraft({ key, draft: { ...emptyDraft, text: `session ${index}` } })
    )
  )
  const parallelDrafts = await Promise.all(sessionKeys.map((key) => readDraft({ key })))
  assert.deepEqual(
    parallelDrafts.map((result) => result.draft?.text),
    sessionKeys.map((_, index) => `session ${index}`)
  )

  const oversized = await writeDraft({
    key: richKey,
    draft: {
      ...emptyDraft,
      images: [
        {
          id: 'too-large',
          dataUrl: `data:image/png;base64,${'A'.repeat(
            Math.ceil((INPUT_DRAFT_MAX_IMAGE_BYTES * 4) / 3) + 8
          )}`,
          mediaType: 'image/png'
        }
      ]
    }
  })
  assert.equal(oversized.success, false)
  assert.equal((await readDraft({ key: richKey })).draft?.text, richDraft.text)

  for (let index = 0; index < INPUT_DRAFT_MAX_COUNT + 5; index += 1) {
    const result = await writeDraft({
      key: getCustomInputDraftKey('capacity', String(index)),
      draft: { ...emptyDraft, text: String(index) }
    })
    assert.equal(result.success, true)
  }
  const indexPath = path.join(tempDirectory, 'index-v1.json')
  const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
    drafts: Record<string, { updatedAt: number }>
  }
  assert.equal(Object.keys(index.drafts).length, INPUT_DRAFT_MAX_COUNT)
  assert.equal(
    (await readdir(tempDirectory)).some((name) => name.endsWith('.tmp')),
    false
  )

  const expiredKey = getCustomInputDraftKey('ttl', 'expired')
  assert.equal(
    (await writeDraft({ key: expiredKey, draft: { ...emptyDraft, text: 'expired' } })).success,
    true
  )
  const expiringIndex = JSON.parse(await readFile(indexPath, 'utf8')) as {
    drafts: Record<string, { fileName: string; updatedAt: number; bytes: number }>
  }
  expiringIndex.drafts[expiredKey].updatedAt = Date.now() - INPUT_DRAFT_TTL_MS - 1
  await writeFile(indexPath, JSON.stringify(expiringIndex), 'utf8')
  assert.equal((await readDraft({ key: expiredKey })).draft, null)

  assert.equal((await deleteDraft({ key: richKey })).success, true)
  assert.equal((await readDraft({ key: richKey })).draft, null)

  assert.deepEqual(normalizeMessageContent('legacy'), [{ type: 'text', text: 'legacy' }])
  assert.equal(
    isCanonicalContentBlock({ type: 'extension', kind: 'future', data: { value: 1 } }),
    true
  )
  assert.equal(isCanonicalContentBlock({ type: 'unknown' }), false)

  console.log('input-drafts verification passed')
} finally {
  await rm(tempDirectory, { recursive: true, force: true })
}
