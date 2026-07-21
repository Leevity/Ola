import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import {
  INPUT_DRAFT_MAX_COUNT,
  INPUT_DRAFT_MAX_IMAGE_BYTES,
  INPUT_DRAFT_MAX_TEXT_CHARS,
  INPUT_DRAFT_MAX_TOTAL_IMAGE_BYTES,
  INPUT_DRAFT_SCHEMA_VERSION,
  INPUT_DRAFT_TTL_MS,
  hasInputDraftContent,
  parseInputDraftScope,
  type InputDraftContent,
  type InputDraftDeleteRequest,
  type InputDraftMutationResult,
  type InputDraftReadRequest,
  type InputDraftReadResult,
  type InputDraftSelectedFile,
  type InputDraftWriteRequest,
  type PersistedInputDraft
} from '../../shared/input-draft-types'

let draftDirectory = join(homedir(), '.ola', 'input-drafts')
let indexPath = join(draftDirectory, 'index-v1.json')

export function configureInputDraftDirectoryForTests(path: string): void {
  draftDirectory = path
  indexPath = join(draftDirectory, 'index-v1.json')
  mutationQueue = Promise.resolve()
}

interface DraftIndexEntry {
  fileName: string
  updatedAt: number
  bytes: number
}

interface DraftIndex {
  version: typeof INPUT_DRAFT_SCHEMA_VERSION
  drafts: Record<string, DraftIndexEntry>
}

let mutationQueue: Promise<void> = Promise.resolve()

function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createEmptyIndex(): DraftIndex {
  return { version: INPUT_DRAFT_SCHEMA_VERSION, drafts: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeSelectedFile(value: unknown): InputDraftSelectedFile | null {
  if (!isRecord(value)) return null
  const stringFields = ['id', 'name', 'originalPath', 'sendPath', 'previewPath'] as const
  if (stringFields.some((field) => typeof value[field] !== 'string' || !value[field])) return null
  return {
    id: value.id as string,
    name: value.name as string,
    originalPath: value.originalPath as string,
    sendPath: value.sendPath as string,
    previewPath: value.previewPath as string,
    isWorkspaceFile: value.isWorkspaceFile === true
  }
}

function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  return Math.ceil((payload.length * 3) / 4)
}

function sanitizeContent(value: unknown): InputDraftContent {
  if (!isRecord(value)) throw new Error('Invalid input draft content')
  const text = typeof value.text === 'string' ? value.text : ''
  if (text.length > INPUT_DRAFT_MAX_TEXT_CHARS) {
    throw new Error(`Input draft text exceeds ${INPUT_DRAFT_MAX_TEXT_CHARS} characters`)
  }

  let totalImageBytes = 0
  const images = Array.isArray(value.images)
    ? value.images.flatMap((item) => {
        if (!isRecord(item)) return []
        if (
          typeof item.id !== 'string' ||
          typeof item.dataUrl !== 'string' ||
          typeof item.mediaType !== 'string'
        ) {
          return []
        }
        const bytes = estimateDataUrlBytes(item.dataUrl)
        if (bytes > INPUT_DRAFT_MAX_IMAGE_BYTES) {
          throw new Error(`Input draft image exceeds ${INPUT_DRAFT_MAX_IMAGE_BYTES} bytes`)
        }
        totalImageBytes += bytes
        return [{ id: item.id, dataUrl: item.dataUrl, mediaType: item.mediaType }]
      })
    : []
  if (totalImageBytes > INPUT_DRAFT_MAX_TOTAL_IMAGE_BYTES) {
    throw new Error(`Input draft images exceed ${INPUT_DRAFT_MAX_TOTAL_IMAGE_BYTES} bytes`)
  }

  const selectedFiles = Array.isArray(value.selectedFiles)
    ? value.selectedFiles
        .map(sanitizeSelectedFile)
        .filter((item): item is InputDraftSelectedFile => item !== null)
    : []
  return {
    text,
    images,
    skill: typeof value.skill === 'string' && value.skill.trim() ? value.skill : null,
    selectedFiles
  }
}

function sanitizePersistedDraft(value: unknown, expectedKey: string): PersistedInputDraft | null {
  if (
    !isRecord(value) ||
    value.version !== INPUT_DRAFT_SCHEMA_VERSION ||
    value.key !== expectedKey
  ) {
    return null
  }
  const scope = parseInputDraftScope(expectedKey)
  if (!scope) return null
  const updatedAt = typeof value.updatedAt === 'number' ? value.updatedAt : 0
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null
  return {
    version: INPUT_DRAFT_SCHEMA_VERSION,
    key: expectedKey,
    scope,
    updatedAt,
    ...sanitizeContent(value)
  }
}

function validateDraftKey(key: unknown): string {
  if (
    typeof key !== 'string' ||
    key.length < 4 ||
    key.length > 1_024 ||
    !parseInputDraftScope(key)
  ) {
    throw new Error('Invalid input draft key')
  }
  return key
}

async function ensureDraftDirectory(): Promise<void> {
  await mkdir(draftDirectory, { recursive: true, mode: 0o700 })
}

async function readIndex(): Promise<DraftIndex> {
  try {
    const parsed = JSON.parse(await readFile(indexPath, 'utf8')) as unknown
    if (
      !isRecord(parsed) ||
      parsed.version !== INPUT_DRAFT_SCHEMA_VERSION ||
      !isRecord(parsed.drafts)
    ) {
      return createEmptyIndex()
    }
    const drafts: Record<string, DraftIndexEntry> = {}
    for (const [key, rawEntry] of Object.entries(parsed.drafts)) {
      if (!parseInputDraftScope(key) || !isRecord(rawEntry)) continue
      if (
        typeof rawEntry.fileName !== 'string' ||
        basename(rawEntry.fileName) !== rawEntry.fileName ||
        typeof rawEntry.updatedAt !== 'number' ||
        typeof rawEntry.bytes !== 'number'
      ) {
        continue
      }
      drafts[key] = {
        fileName: rawEntry.fileName,
        updatedAt: rawEntry.updatedAt,
        bytes: rawEntry.bytes
      }
    }
    return { version: INPUT_DRAFT_SCHEMA_VERSION, drafts }
  } catch {
    return createEmptyIndex()
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<number> {
  const serialized = JSON.stringify(value)
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, serialized, { encoding: 'utf8', mode: 0o600 })
  await rename(tempPath, path)
  return Buffer.byteLength(serialized)
}

async function writeIndex(index: DraftIndex): Promise<void> {
  await writeJsonAtomically(indexPath, index)
}

async function cleanupIndex(index: DraftIndex, now = Date.now()): Promise<boolean> {
  let changed = false
  const entries = Object.entries(index.drafts).sort(
    (left, right) => right[1].updatedAt - left[1].updatedAt
  )
  const retained = new Set(entries.slice(0, INPUT_DRAFT_MAX_COUNT).map(([key]) => key))
  for (const [key, entry] of entries) {
    const expired = now - entry.updatedAt > INPUT_DRAFT_TTL_MS
    if (!expired && retained.has(key)) continue
    delete index.drafts[key]
    await rm(join(draftDirectory, entry.fileName), { force: true }).catch(() => {})
    changed = true
  }
  return changed
}

async function cleanupOrphans(index: DraftIndex): Promise<void> {
  const referenced = new Set(Object.values(index.drafts).map((entry) => entry.fileName))
  const files = await readdir(draftDirectory).catch(() => [])
  await Promise.all(
    files
      .filter((fileName) => fileName.endsWith('.json') && fileName !== basename(indexPath))
      .filter((fileName) => !referenced.has(fileName))
      .map(async (fileName) => {
        const filePath = join(draftDirectory, fileName)
        const fileStat = await stat(filePath).catch(() => null)
        if (fileStat && Date.now() - fileStat.mtimeMs > 60_000) {
          await rm(filePath, { force: true }).catch(() => {})
        }
      })
  )
}

async function withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueue
  let release: () => void = () => {}
  mutationQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

export async function readDraft(request: InputDraftReadRequest): Promise<InputDraftReadResult> {
  try {
    const key = validateDraftKey(request?.key)
    await mutationQueue
    await ensureDraftDirectory()
    const index = await readIndex()
    const entry = index.drafts[key]
    if (!entry) return { success: true, draft: null }
    if (Date.now() - entry.updatedAt > INPUT_DRAFT_TTL_MS) {
      await deleteDraft({ key })
      return { success: true, draft: null }
    }
    const raw = JSON.parse(await readFile(join(draftDirectory, entry.fileName), 'utf8'))
    const draft = sanitizePersistedDraft(raw, key)
    if (!draft) {
      await deleteDraft({ key })
      return { success: true, draft: null }
    }
    return { success: true, draft }
  } catch (error) {
    return { success: false, draft: null, error: serializeError(error) }
  }
}

export async function writeDraft(
  request: InputDraftWriteRequest
): Promise<InputDraftMutationResult> {
  try {
    const key = validateDraftKey(request?.key)
    const content = sanitizeContent(request?.draft)
    if (!hasInputDraftContent(content)) return await deleteDraft({ key })
    return await withMutationLock(async () => {
      await ensureDraftDirectory()
      const index = await readIndex()
      const updatedAt = Date.now()
      const scope = parseInputDraftScope(key)!
      const digest = createHash('sha256').update(key).digest('hex').slice(0, 24)
      const fileName = `${digest}-${updatedAt}-${randomUUID()}.json`
      const previousFileName = index.drafts[key]?.fileName
      const bytes = await writeJsonAtomically(join(draftDirectory, fileName), {
        version: INPUT_DRAFT_SCHEMA_VERSION,
        key,
        scope,
        updatedAt,
        ...content
      } satisfies PersistedInputDraft)
      index.drafts[key] = { fileName, updatedAt, bytes }
      await cleanupIndex(index, updatedAt)
      await writeIndex(index)
      if (previousFileName && previousFileName !== fileName) {
        await rm(join(draftDirectory, previousFileName), { force: true }).catch(() => {})
      }
      await cleanupOrphans(index)
      return { success: true }
    })
  } catch (error) {
    return { success: false, error: serializeError(error) }
  }
}

export async function deleteDraft(
  request: InputDraftDeleteRequest
): Promise<InputDraftMutationResult> {
  try {
    const key = validateDraftKey(request?.key)
    return await withMutationLock(async () => {
      await ensureDraftDirectory()
      const index = await readIndex()
      const entry = index.drafts[key]
      if (!entry) return { success: true }
      delete index.drafts[key]
      await writeIndex(index)
      await rm(join(draftDirectory, entry.fileName), { force: true }).catch(() => {})
      return { success: true }
    })
  } catch (error) {
    return { success: false, error: serializeError(error) }
  }
}

export async function registerInputDraftHandlers(): Promise<void> {
  const { registerMessagePackHandler } = await import('./messagepack-handler')
  registerMessagePackHandler<InputDraftReadRequest, InputDraftReadResult>(
    'input-draft:read',
    readDraft
  )
  registerMessagePackHandler<InputDraftWriteRequest, InputDraftMutationResult>(
    'input-draft:write',
    writeDraft
  )
  registerMessagePackHandler<InputDraftDeleteRequest, InputDraftMutationResult>(
    'input-draft:delete',
    deleteDraft
  )
  registerMessagePackHandler<void, InputDraftMutationResult>('input-draft:flush', async () => {
    try {
      await mutationQueue
      return { success: true }
    } catch (error) {
      return { success: false, error: serializeError(error) }
    }
  })

  void withMutationLock(async () => {
    await ensureDraftDirectory()
    const index = await readIndex()
    if (await cleanupIndex(index)) await writeIndex(index)
    await cleanupOrphans(index)
  }).catch((error) => console.warn('[InputDrafts] cleanup failed:', serializeError(error)))
}
