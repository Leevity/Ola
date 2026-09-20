import { isAbsolute, join } from 'node:path'
import { BusinessRepository } from '../../runtime/storage/business-repository'
import { olaDataRoot } from '../lib/ola-data-root'

let repository: BusinessRepository | null = null
let repositoryKey: string | null = null
let promotedRepository: BusinessRepository | null = null
let promotedRepositoryKey: string | null = null

/**
 * TS is the default local business writer. An explicit handover configuration
 * still opens a verified copy, and neither mode falls back to Native after a
 * failed mutation: splitting one user action across two databases would make
 * rollback impossible to reason about.
 */
export function businessWriteCanary(): BusinessRepository | null {
  if (promotedRepository) return promotedRepository
  const directPath = join(olaDataRoot(), 'data.db')
  const handoverEnabled = process.env.OLA_TS_BUSINESS_WRITES === '1'
  const path = handoverEnabled ? process.env.OLA_TS_BUSINESS_WRITE_PATH?.trim() : directPath
  const handoverManifestPath = handoverEnabled
    ? process.env.OLA_TS_BUSINESS_WRITE_MANIFEST?.trim()
    : undefined
  if (
    !path ||
    !isAbsolute(path) ||
    (handoverEnabled && (!handoverManifestPath || !isAbsolute(handoverManifestPath)))
  )
    throw new Error('TS_BUSINESS_WRITE_HANDOVER_REQUIRED')
  const key = `${path}\0${handoverManifestPath}`
  if (repository && repositoryKey !== key) {
    throw new Error('TS_BUSINESS_WRITE_HANDOVER_CHANGED')
  }
  if (!repository) {
    repository = new BusinessRepository({
      path,
      handoverManifestPath,
      mode: handoverEnabled ? 'handover' : 'direct'
    })
    repositoryKey = key
  }
  return repository
}

/** Main-process adapter for DAO routes that use the shared `db/*` contract. */
export function getTsDatabaseRouteGuard(): {
  request<T>(_method: string, _params?: unknown, _timeoutMs?: number): Promise<T>
} {
  const repository = businessWriteCanary()
  if (!repository) throw new Error('TS_BUSINESS_REPOSITORY_UNAVAILABLE')
  return {
    request: <T>(method: string, params?: unknown) => repository.request<T>(method, params)
  }
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
