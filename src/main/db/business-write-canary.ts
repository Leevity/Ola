import { isAbsolute } from 'node:path'
import { BusinessRepository } from '../../runtime/storage/business-repository'

let repository: BusinessRepository | null = null
let repositoryKey: string | null = null
let promotedRepository: BusinessRepository | null = null
let promotedRepositoryKey: string | null = null

/**
 * Explicit opt-in for a verified handover copy. An enabled writer never
 * falls back to Native after a failed mutation: doing so could split one user
 * action across two databases and make rollback impossible to reason about.
 */
export function businessWriteCanary(): BusinessRepository | null {
  if (promotedRepository) return promotedRepository
  if (process.env.OLA_TS_BUSINESS_WRITES !== '1') return null
  const path = process.env.OLA_TS_BUSINESS_WRITE_PATH?.trim()
  const handoverManifestPath = process.env.OLA_TS_BUSINESS_WRITE_MANIFEST?.trim()
  if (!path || !handoverManifestPath || !isAbsolute(path) || !isAbsolute(handoverManifestPath))
    throw new Error('TS_BUSINESS_WRITE_HANDOVER_REQUIRED')
  const key = `${path}\0${handoverManifestPath}`
  if (repository && repositoryKey !== key) {
    throw new Error('TS_BUSINESS_WRITE_HANDOVER_CHANGED')
  }
  if (!repository) {
    repository = new BusinessRepository({ path, handoverManifestPath })
    repositoryKey = key
  }
  return repository
}

/**
 * Promote a repository only after the handover coordinator has quiesced every
 * legacy writer and verified the snapshot/rollback manifest. Keeping this
 * state in Main (instead of mutating process.env) lets a running desktop
 * process switch ownership exactly once and makes failed promotion explicit.
 */
export function promoteBusinessWriteRepository(
  next: BusinessRepository,
  handoverManifestPath: string
): void {
  if (promotedRepository && promotedRepository !== next)
    throw new Error('TS_BUSINESS_WRITE_ALREADY_PROMOTED')
  if (repository && repository !== next) throw new Error('TS_BUSINESS_WRITE_CANARY_ALREADY_OPEN')
  if (!handoverManifestPath) throw new Error('TS_BUSINESS_WRITE_HANDOVER_REQUIRED')
  promotedRepository = next
  promotedRepositoryKey = handoverManifestPath
  repository = next
  repositoryKey = `promoted\0${handoverManifestPath}`
}

export function businessWritePromotionStatus(): {
  promoted: boolean
  handoverManifestPath?: string
} {
  return promotedRepository
    ? { promoted: true, handoverManifestPath: promotedRepositoryKey ?? undefined }
    : { promoted: false }
}

/** Returns the promoted repository for read canaries after ownership transfer. */
export function promotedBusinessWriteRepository(): BusinessRepository | null {
  return promotedRepository
}

export async function closeBusinessWriteCanary(): Promise<void> {
  const current = repository
  repository = null
  repositoryKey = null
  promotedRepository = null
  promotedRepositoryKey = null
  await current?.close().catch(() => undefined)
}
