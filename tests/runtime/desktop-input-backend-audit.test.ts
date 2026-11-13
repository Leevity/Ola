import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  audit: [] as Array<{ action: string; success: boolean; error?: string }>,
  loadError: null as Error | null,
  robot: {
    setMouseDelay: vi.fn(),
    moveMouse: vi.fn(),
    mouseClick: vi.fn(),
    mouseToggle: vi.fn()
  }
}))

vi.mock('electron', () => ({
  desktopCapturer: { getSources: vi.fn(async () => []) },
  screen: {
    getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]
  },
  systemPreferences: { isTrustedAccessibilityClient: () => true }
}))

vi.mock('../../src/main/remote/remote-audit', () => ({
  recordRemoteAudit: (entry: { action: string; success: boolean; error?: string }) => {
    mocks.audit.push(entry)
  }
}))

// getRobot() loads the native module through createRequire, which bypasses
// Vitest's ESM mock registry, so the interception has to happen at the require
// factory itself rather than on the package name.
vi.mock('module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('module')>()
  const realRequire = actual.createRequire(`${process.cwd()}/package.json`)
  return {
    ...actual,
    createRequire: () => (id: string) => {
      if (id !== '@jitsi/robotjs') return realRequire(id)
      if (mocks.loadError) throw mocks.loadError
      return mocks.robot
    }
  }
})

async function loadDesktopControl() {
  vi.resetModules()
  return await import('../../src/main/ipc/desktop-control')
}

beforeEach(() => {
  mocks.audit.length = 0
  mocks.loadError = null
  vi.clearAllMocks()
})

describe('desktop input backend availability audit', () => {
  it('records the load failure instead of only logging it', async () => {
    mocks.loadError = new Error('NODE_MODULE_VERSION mismatch')
    const { desktopInputClick } = await loadDesktopControl()

    const result = desktopInputClick({ x: 10, y: 20 })

    expect(result.success).toBe(false)
    expect(mocks.audit).toEqual([
      {
        action: 'input_backend_unavailable',
        success: false,
        error: 'NODE_MODULE_VERSION mismatch'
      }
    ])
  })

  it('records the failure once per process, not once per input attempt', async () => {
    mocks.loadError = new Error('missing prebuilt binary')
    const { desktopInputClick } = await loadDesktopControl()

    desktopInputClick({ x: 10, y: 20 })
    desktopInputClick({ x: 30, y: 40 })
    desktopInputClick({ x: 50, y: 60 })

    expect(mocks.audit).toHaveLength(1)
  })

  it('stays silent when the backend loads and the click succeeds', async () => {
    const { desktopInputClick } = await loadDesktopControl()

    const result = desktopInputClick({ x: 10, y: 20 })

    expect(result).toEqual({ success: true, x: 10, y: 20, button: 'left', action: 'click' })
    expect(mocks.robot.moveMouse).toHaveBeenCalledWith(10, 20)
    expect(mocks.audit).toEqual([])
  })

  it('does not blame the backend for a rejected coordinate', async () => {
    const { desktopInputClick } = await loadDesktopControl()

    const result = desktopInputClick({ x: 99999, y: 20 })

    expect(result.success).toBe(false)
    expect(mocks.audit).toEqual([])
  })
})
