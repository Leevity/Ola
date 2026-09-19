import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, bytes: Uint8Array) => Promise<Uint8Array>>()

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
  decodeMessagePackPayload: () => ({}),
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
  businessWritePromotionStatus: () => ({ promoted: false }),
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

describe('business handover status IPC authorization', () => {
  beforeEach(() => {
    handlers.clear()
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
      enabled: false,
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
    const previousFlag = process.env.OLA_ENABLE_BUSINESS_HANDOVER
    process.env.OLA_ENABLE_BUSINESS_HANDOVER = '1'
    desktopRuntime.isAvailable = false
    const sender = { mainFrame: {} }
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({ webContents: sender } as never)
    const handler = handlers.get('migration:business-handover')!
    await expect(
      handler({ sender, senderFrame: sender.mainFrame }, new Uint8Array())
    ).rejects.toThrow('TS_RUNTIME_NOT_READY')
    expect(vi.mocked(quiesceDesktopLegacyBusinessWriter)).not.toHaveBeenCalled()
    if (previousFlag === undefined) delete process.env.OLA_ENABLE_BUSINESS_HANDOVER
    else process.env.OLA_ENABLE_BUSINESS_HANDOVER = previousFlag
  })
})
