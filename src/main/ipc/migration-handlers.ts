import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { MigrationApplyDecision } from '../../shared/migration-types'
import { applyOpenCodeMigration } from '../migration/opencode-apply'
import { buildOpenCodeMigrationPreview } from '../migration/opencode-preview'
import { olaDataRoot } from '../lib/ola-data-root'
import {
  businessHandoverReadiness,
  handoverBusinessDatabase
} from '../../runtime/storage/business-handover-coordinator'
import {
  businessWritePromotionStatus,
  promoteBusinessWriteRepository
} from '../db/business-write-canary'
import { writeBusinessHandoverMarker } from '../db/business-handover-state'
import { registerMessagePackHandler } from './messagepack-handler'
import {
  quiesceDesktopLegacyBusinessWriter,
  resumeDesktopTsChannelWriter
} from '../runtime/business-handover-quiesce'
import { desktopRuntime } from '../runtime/desktop-runtime'

let businessHandoverInFlight: Promise<unknown> | null = null

function assertTrustedMainFrame(event: Electron.IpcMainInvokeEvent): void {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (
    !window ||
    window.webContents !== event.sender ||
    event.senderFrame !== event.sender.mainFrame
  )
    throw new Error('UNTRUSTED_IPC_SENDER')
}

export function registerMigrationHandlers(): void {
  registerMessagePackHandler<string | undefined>('migration:preview', async (source) => {
    if (source && source !== 'opencode') {
      return {
        source,
        detected: false,
        warnings: [`Unsupported migration source: ${source}`],
        items: [],
        summary: { total: 0, conflicts: 0, warnings: 1, actionable: 0 },
        sourcePath: '',
        generatedAt: Date.now()
      }
    }

    return buildOpenCodeMigrationPreview()
  })

  registerMessagePackHandler<{ source?: string; decisions?: MigrationApplyDecision[] } | undefined>(
    'migration:apply',
    async (args) => {
      if (args?.source && args.source !== 'opencode') {
        return {
          source: args.source,
          sourcePath: '',
          backupPath: undefined,
          warnings: [`Unsupported migration source: ${args.source}`],
          results: [],
          summary: { total: 0, applied: 0, skipped: 0, failed: 1 },
          appliedAt: Date.now()
        }
      }

      return applyOpenCodeMigration(Array.isArray(args?.decisions) ? args?.decisions : [])
    }
  )

  registerMessagePackHandler<void>('migration:business-handover-status', async (_args, event) => {
    assertTrustedMainFrame(event)
    const readiness = await businessHandoverReadiness({
      sourcePath: join(olaDataRoot(), 'data.db'),
      backupDirectory: join(olaDataRoot(), 'backups', 'ts-handover')
    })
    return {
      ...businessWritePromotionStatus(),
      inFlight: businessHandoverInFlight !== null,
      runtimeAvailable: desktopRuntime.isAvailable,
      enabled: process.env.OLA_ENABLE_BUSINESS_HANDOVER === '1',
      handoverReady: readiness.ready,
      handoverBlocker: readiness.reason
    }
  })

  registerMessagePackHandler<{ confirm?: boolean } | undefined>(
    'migration:business-handover',
    async (args, event) => {
      assertTrustedMainFrame(event)
      if (process.env.OLA_ENABLE_BUSINESS_HANDOVER !== '1')
        throw new Error('BUSINESS_HANDOVER_NOT_ENABLED')
      if (!desktopRuntime.isAvailable) throw new Error('TS_RUNTIME_NOT_READY')
      if (args?.confirm !== true) throw new Error('BUSINESS_HANDOVER_CONFIRMATION_REQUIRED')
      const current = businessWritePromotionStatus()
      if (current.promoted) return { ...current, inFlight: false }
      if (businessHandoverInFlight) return businessHandoverInFlight

      const sourcePath = join(olaDataRoot(), 'data.db')
      const backupDirectory = join(olaDataRoot(), 'backups', 'ts-handover')
      businessHandoverInFlight = (async () => {
        const result = await handoverBusinessDatabase({
          sourcePath,
          backupDirectory,
          quiesceLegacyWriter: quiesceDesktopLegacyBusinessWriter
        })
        writeBusinessHandoverMarker({
          manifestPath: result.snapshot.manifestPath,
          backupPath: result.snapshot.backupPath
        })
        promoteBusinessWriteRepository(result.repository, result.snapshot.manifestPath)
        if (process.env.OLA_ENABLE_TS_CHANNEL_RESUME === '1') {
          await resumeDesktopTsChannelWriter()
        }
        return {
          promoted: true,
          handoverManifestPath: result.snapshot.manifestPath,
          backupPath: result.snapshot.backupPath,
          rollbackDrillPath: result.rollbackDrill.restoredPath,
          channelsResumed: process.env.OLA_ENABLE_TS_CHANNEL_RESUME === '1',
          inFlight: false
        }
      })()
      try {
        return await businessHandoverInFlight
      } finally {
        businessHandoverInFlight = null
      }
    }
  )
}
