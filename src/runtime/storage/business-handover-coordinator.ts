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
  warning?: string
}

/** Read-only gate used by settings to explain why promotion is unavailable. */
export async function businessHandoverReadiness(input: {
  sourcePath: string
  backupDirectory?: string
}): Promise<BusinessHandoverReadiness> {
  try {
    const contract = await verifyLegacyBusinessDatabaseContract({ sourcePath: input.sourcePath })
    const minimumFreeBytes = await minimumLegacyHandoverFreeBytes(input.sourcePath)
    if (input.backupDirectory)
      await inspectLegacyHandoverBackupDirectory(input.backupDirectory, minimumFreeBytes)
    const wiki = contract.nativeProjectWiki
    return {
      ready: true,
      ...(wiki && (wiki.documents > 0 || wiki.generationRuns > 0)
        ? { warning: 'LEGACY_NATIVE_WIKI_DATA_WILL_BE_PRESERVED_IN_TS_ARCHIVE' }
        : {})
    }
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
  const initialContract = await verifyLegacyBusinessDatabaseContract({
    sourcePath: input.sourcePath
  })
  await prepareLegacyHandoverBackupDirectory(
    input.backupDirectory,
    await minimumLegacyHandoverFreeBytes(input.sourcePath)
  )
  await input.quiesceLegacyWriter()
  const quiescedContract = await verifyLegacyBusinessDatabaseContract({
    sourcePath: input.sourcePath
  })
  if (
    initialContract.nativeProjectWiki &&
    (!quiescedContract.nativeProjectWiki ||
      quiescedContract.nativeProjectWiki.documents < initialContract.nativeProjectWiki.documents ||
      quiescedContract.nativeProjectWiki.generationRuns <
        initialContract.nativeProjectWiki.generationRuns)
  )
    throw new Error('LEGACY_NATIVE_WIKI_SOURCE_CHANGED_DURING_HANDOVER')
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
    const sourceWiki = initialContract.nativeProjectWiki
    if (sourceWiki) {
      const archivedWiki = await repository.legacyProjectWikiCounts()
      if (
        archivedWiki.documents < sourceWiki.documents ||
        archivedWiki.generationRuns < sourceWiki.generationRuns
      ) {
        throw new Error('LEGACY_NATIVE_WIKI_ARCHIVE_INCOMPLETE')
      }
    }
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
