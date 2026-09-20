import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>>()
const mockState = vi.hoisted(() => ({ decodedArgs: {} as unknown }))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>) => {
        handlers.set(channel, handler)
      }
    )
  }
}))
vi.mock('../../src/shared/messagepack/binary-ipc', () => ({
  decodeMessagePackPayload: () => mockState.decodedArgs,
  encodeMessagePackPayload: (value: unknown) => value,
  toMessagePackChannel: (channel: string) => channel
}))
vi.mock('../../src/main/migration/opencode-apply', () => ({ applyOpenCodeMigration: vi.fn() }))
vi.mock('../../src/main/migration/opencode-preview', () => ({
  buildOpenCodeMigrationPreview: vi.fn()
}))
vi.mock('../../src/runtime/storage/business-handover-coordinator', () => ({
  handoverBusinessDatabase: vi.fn(),
  businessHandoverReadiness: vi.fn(async () => ({ ready: true }))
}))
vi.mock('../../src/main/db/business-handover-state', () => ({
  writeBusinessHandoverMarker: vi.fn()
}))
vi.mock('../../src/main/db/business-write-canary', () => ({
  businessWritePromotionStatus: vi.fn(() => ({ promoted: false })),
  promoteBusinessWriteRepository: vi.fn()
}))
vi.mock('../../src/main/runtime/business-handover-quiesce', () => ({
  quiesceDesktopLegacyBusinessWriter: vi.fn()
}))
vi.mock('../../src/main/runtime/desktop-runtime', () => ({
  desktopRuntime: { isAvailable: true }
}))

import { BrowserWindow } from 'electron'
import { registerMigrationHandlers } from '../../src/main/ipc/migration-handlers'
import { desktopRuntime } from '../../src/main/runtime/desktop-runtime'
import { quiesceDesktopLegacyBusinessWriter } from '../../src/main/runtime/business-handover-quiesce'
import { handoverBusinessDatabase } from '../../src/runtime/storage/business-handover-coordinator'
import {
  businessWritePromotionStatus,
  promoteBusinessWriteRepository
} from '../../src/main/db/business-write-canary'
import { writeBusinessHandoverMarker } from '../../src/main/db/business-handover-state'

describe('business handover status IPC authorization', () => {
  beforeEach(() => {
    handlers.clear()
    mockState.decodedArgs = {}
    vi.clearAllMocks()
    vi.mocked(businessWritePromotionStatus).mockReturnValue({ promoted: false })
    vi.mocked(BrowserWindow.fromWebContents).mockReset()
    registerMigrationHandlers()
  })

  it('accepts only the registered main frame', async () => {
    const mainFrame = {}
    const sender = { mainFrame }
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({ webContents: sender } as never)
    const handler = handlers.get('migration:business-handover-status')
    expect(handler).toBeDefined()
    await expect(handler!({ sender, senderFrame: mainFrame }, new Uint8Array())).resolves.toEqual({
      promoted: false,
      inFlight: false,
      runtimeAvailable: true,
      enabled: true,
      handoverReady: true
    })
  })

  it('rejects a guest or child frame before exposing ownership state', async () => {
    const mainFrame = {}
    const sender = { mainFrame }
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({ webContents: sender } as never)
    const handler = handlers.get('migration:business-handover-status')!
    await expect(handler({ sender, senderFrame: {}, mainFrame }, new Uint8Array())).rejects.toThrow(
      'UNTRUSTED_IPC_SENDER'
    )
    await expect(
      handler({ sender: {}, senderFrame: mainFrame, mainFrame }, new Uint8Array())
    ).rejects.toThrow('UNTRUSTED_IPC_SENDER')
  })

  it('does not quiesce Native when the TS runtime is unavailable', async () => {
    vi.spyOn(desktopRuntime, 'isAvailable', 'get').mockReturnValue(false)
    const sender = { mainFrame: {} }
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({ webContents: sender } as never)
    const handler = handlers.get('migration:business-handover')!
    await expect(
      handler({ sender, senderFrame: sender.mainFrame }, new Uint8Array())
    ).rejects.toThrow('TS_RUNTIME_NOT_READY')
    expect(vi.mocked(quiesceDesktopLegacyBusinessWriter)).not.toHaveBeenCalled()
  })

  it('requires an explicit confirmation before quiescing Native', async () => {
    const sender = { mainFrame: {} }
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({ webContents: sender } as never)
    const handler = handlers.get('migration:business-handover')!
    await expect(
      handler({ sender, senderFrame: sender.mainFrame }, new Uint8Array())
    ).rejects.toThrow('BUSINESS_HANDOVER_CONFIRMATION_REQUIRED')
    expect(vi.mocked(quiesceDesktopLegacyBusinessWriter)).not.toHaveBeenCalled()
  })

  it('does not report success until the promoted repository is confirmed', async () => {
    const sender = { mainFrame: {} }
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({ webContents: sender } as never)
    vi.mocked(handoverBusinessDatabase).mockResolvedValue({
      snapshot: {
        manifestPath: '/tmp/handover.manifest.json',
        backupPath: '/tmp/handover.db'
      } as never,
      rollbackDrill: { restoredPath: '/tmp/rollback.db', drillDirectory: '/tmp/drill' },
      repository: {} as never
    })
    const handler = handlers.get('migration:business-handover')!
    mockState.decodedArgs = { confirm: true }
    await expect(
      handler({ sender, senderFrame: sender.mainFrame }, new Uint8Array())
    ).rejects.toThrow('BUSINESS_HANDOVER_PROMOTION_NOT_CONFIRMED')
    expect(vi.mocked(writeBusinessHandoverMarker)).toHaveBeenCalledOnce()
    expect(vi.mocked(promoteBusinessWriteRepository)).toHaveBeenCalledOnce()
  })

  it('returns the handover artifacts only after promotion is confirmed', async () => {
    const sender = { mainFrame: {} }
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({ webContents: sender } as never)
    const snapshot = { manifestPath: '/tmp/handover.manifest.json', backupPath: '/tmp/handover.db' }
    vi.mocked(handoverBusinessDatabase).mockResolvedValue({
      snapshot: snapshot as never,
      rollbackDrill: { restoredPath: '/tmp/rollback.db', drillDirectory: '/tmp/drill' },
      repository: {} as never
    })
    vi.mocked(businessWritePromotionStatus)
      .mockReturnValueOnce({ promoted: false })
      .mockReturnValueOnce({
        promoted: true,
        handoverManifestPath: snapshot.manifestPath
      })
    const handler = handlers.get('migration:business-handover')!
    mockState.decodedArgs = { confirm: true }
    await expect(
      handler({ sender, senderFrame: sender.mainFrame }, new Uint8Array())
    ).resolves.toEqual({
      promoted: true,
      handoverManifestPath: snapshot.manifestPath,
      backupPath: snapshot.backupPath,
      rollbackDrillPath: '/tmp/rollback.db',
      channelsResumed: false,
      inFlight: false
    })
  })
})
