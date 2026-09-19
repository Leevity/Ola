import { BusinessRepository } from './business-repository'
import {
  createLegacyRollbackDrill,
  createLegacyDatabaseHandoverSnapshot,
  inspectLegacyHandoverBackupDirectory,
  minimumLegacyHandoverFreeBytes,
  prepareLegacyHandoverBackupDirectory,
  verifyLegacyBusinessDatabaseContract,
  verifyLegacyDatabaseHandoverSnapshot,
  verifyQuiescedLegacySourceUnchanged,
  type LegacyDatabaseHandoverSnapshot
} from './legacy-database-handover'

export interface BusinessHandoverResult {
  snapshot: LegacyDatabaseHandoverSnapshot
  rollbackDrill: { restoredPath: string; drillDirectory: string }
  repository: BusinessRepository
}

export interface BusinessHandoverReadiness {
  ready: boolean
  reason?: string
}

/** Read-only gate used by settings to explain why promotion is unavailable. */
export async function businessHandoverReadiness(input: {
  sourcePath: string
  backupDirectory?: string
}): Promise<BusinessHandoverReadiness> {
  try {
    await verifyLegacyBusinessDatabaseContract({ sourcePath: input.sourcePath })
    const minimumFreeBytes = await minimumLegacyHandoverFreeBytes(input.sourcePath)
    if (input.backupDirectory)
      await inspectLegacyHandoverBackupDirectory(input.backupDirectory, minimumFreeBytes)
    return { ready: true }
  } catch (error) {
    return {
      ready: false,
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * The caller must park the Native Worker and all other legacy write entry
 * points in quiesceLegacyWriter. A failed handover leaves them parked; this
 * function never silently restarts the old writer after a partial promotion.
 */
export async function handoverBusinessDatabase(input: {
  sourcePath: string
  backupDirectory: string
  quiesceLegacyWriter: () => Promise<void>
}): Promise<BusinessHandoverResult> {
  await verifyLegacyBusinessDatabaseContract({ sourcePath: input.sourcePath })
  await prepareLegacyHandoverBackupDirectory(
    input.backupDirectory,
    await minimumLegacyHandoverFreeBytes(input.sourcePath)
  )
  await input.quiesceLegacyWriter()
  await verifyLegacyBusinessDatabaseContract({ sourcePath: input.sourcePath })
  const snapshot = await createLegacyDatabaseHandoverSnapshot({
    ...input,
    requireQuiescedSource: true
  })
  await verifyLegacyDatabaseHandoverSnapshot({ manifestPath: snapshot.manifestPath })
  const rollbackDrill = await createLegacyRollbackDrill({
    manifestPath: snapshot.manifestPath,
    restoreDirectory: input.backupDirectory
  })
  await verifyQuiescedLegacySourceUnchanged(snapshot)
  const repository = new BusinessRepository({
    path: snapshot.backupPath,
    handoverManifestPath: snapshot.manifestPath
  })
  try {
    await repository.migrationStatus()
    // Native used to repair historical ordering as a read side effect. Once
    // parked, only the promoted copy may be changed; the rollback stays exact.
    await repository.normalizeMessageSortOrders()
    // A stray legacy writer may resume while TS migrations run. Do not expose
    // the promoted repository unless the source is still the snapshotted one.
    await verifyQuiescedLegacySourceUnchanged(snapshot)
    return { snapshot, rollbackDrill, repository }
  } catch (error) {
    await repository.close()
    throw error
  }
}
