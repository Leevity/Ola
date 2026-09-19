import { chmodSync, renameSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { olaDataRoot } from '../lib/ola-data-root'
import { BusinessRepository } from '../../runtime/storage/business-repository'
import { promoteBusinessWriteRepository } from './business-write-canary'

export interface BusinessHandoverMarker {
  version: 1
  manifestPath: string
  backupPath: string
  promotedAt: string
}

function markerPath(): string {
  return join(olaDataRoot(), 'business-handover.active.json')
}

export function readBusinessHandoverMarker(): BusinessHandoverMarker | null {
  const path = markerPath()
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BusinessHandoverMarker>
    if (
      parsed.version !== 1 ||
      typeof parsed.manifestPath !== 'string' ||
      typeof parsed.backupPath !== 'string' ||
      !isAbsolute(parsed.manifestPath) ||
      !isAbsolute(parsed.backupPath)
    )
      throw new Error('BUSINESS_HANDOVER_MARKER_INVALID')
    return {
      version: 1,
      manifestPath: resolve(parsed.manifestPath),
      backupPath: resolve(parsed.backupPath),
      promotedAt: typeof parsed.promotedAt === 'string' ? parsed.promotedAt : ''
    }
  } catch (error) {
    throw new Error('BUSINESS_HANDOVER_MARKER_INVALID', { cause: error })
  }
}

export function writeBusinessHandoverMarker(input: {
  manifestPath: string
  backupPath: string
}): BusinessHandoverMarker {
  const marker: BusinessHandoverMarker = {
    version: 1,
    manifestPath: resolve(input.manifestPath),
    backupPath: resolve(input.backupPath),
    promotedAt: new Date().toISOString()
  }
  const destination = markerPath()
  const temporary = `${destination}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, destination)
  return marker
}

export function clearBusinessHandoverMarker(): void {
  try {
    unlinkSync(markerPath())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/**
 * Reopens a previously promoted copy on restart. The marker is written only
 * after an explicitly confirmed handover, so its presence is the durable
 * ownership decision; a restart must not silently resurrect the legacy writer.
 */
export async function restoreBusinessHandoverIfEnabled(): Promise<BusinessHandoverMarker | null> {
  const marker = readBusinessHandoverMarker()
  if (!marker) return null
  const repository = new BusinessRepository({
    path: marker.backupPath,
    handoverManifestPath: marker.manifestPath
  })
  try {
    await repository.migrationStatus()
    promoteBusinessWriteRepository(repository, marker.manifestPath)
    return marker
  } catch (error) {
    await repository.close().catch(() => undefined)
    throw error
  }
}
