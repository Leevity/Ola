import { describe, expect, it, vi } from 'vitest'
import { executeNotifyTool } from '../../src/renderer/src/lib/tools/notify-tool'

describe('TS Notify tool', () => {
  it('routes a bounded notification to the Main IPC handler', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true })
    await expect(
      executeNotifyTool(
        {
          title: ' Done ',
          body: ' Finished ',
          type: 'success',
          duration: 99_999
        },
        { invoke }
      )
    ).resolves.toBe(JSON.stringify({ success: true }))
    expect(invoke).toHaveBeenCalledWith('notify:desktop', {
      title: 'Done',
      body: 'Finished',
      type: 'success',
      duration: 60_000
    })
  })

  it('rejects empty content without touching IPC', async () => {
    const invoke = vi.fn()
    await expect(executeNotifyTool({ title: '', body: 'x' }, { invoke })).resolves.toBe(
      JSON.stringify({ error: 'Notify requires title and body.' })
    )
    expect(invoke).not.toHaveBeenCalled()
  })
})
