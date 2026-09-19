import { describe, expect, it, vi } from 'vitest'
import { createDesktopNotificationTool } from '../../src/main/runtime/desktop-notification-runtime-tool'

describe('desktop notification runtime tool', () => {
  it('keeps Electron delivery in a Main adapter and bounds model input', async () => {
    const deliver = vi.fn()
    const tool = createDesktopNotificationTool(deliver)
    const value = tool.validate({ title: ' Done ', body: ' Completed ', duration: 5_000 })
    await expect(
      tool.execute(value, { signal: new AbortController().signal } as never)
    ).resolves.toEqual({
      success: true,
      title: 'Done',
      body: 'Completed'
    })
    expect(deliver).toHaveBeenCalledWith('Done', 'Completed')
    expect(() => tool.validate({ title: '', body: 'x' })).toThrow('INVALID_TOOL_INPUT')
    expect(() => tool.validate({ title: 'x', body: 'y', extra: true })).toThrow(
      'INVALID_TOOL_INPUT'
    )
  })
})
