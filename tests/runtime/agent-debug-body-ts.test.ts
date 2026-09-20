import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readRuntimeDebugBody } from '../../src/renderer/src/lib/ipc/runtime-debug-body'

const state = vi.hoisted(() => ({ body: '' }))
vi.mock('../../src/renderer/src/lib/debug-store', () => ({
  getRequestTraceInfo: (ref: string) =>
    ref === 'debug-message-1' ? { debugInfo: { body: state.body } } : undefined
}))

describe('TS runtime debug body reader', () => {
  beforeEach(() => {
    state.body = '{"prompt":"hello"}'
  })

  it('reads bounded bodies from the TS-owned renderer debug store', async () => {
    await expect(readRuntimeDebugBody('debug-message-1')).resolves.toBe('{"prompt":"hello"}')
  })

  it('supports encoded text refs and fails closed for unknown refs', async () => {
    await expect(readRuntimeDebugBody('data:text/plain,hello%20world')).resolves.toBe('hello world')
    await expect(readRuntimeDebugBody('missing-ref')).rejects.toThrow(
      'TS_RUNTIME_DEBUG_BODY_NOT_FOUND'
    )
  })
})
