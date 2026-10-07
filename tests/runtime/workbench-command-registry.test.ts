import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getWorkbenchActionsSnapshot,
  registerWorkbenchAction,
  runWorkbenchAction
} from '../../src/renderer/src/lib/workbench/registry'

describe('workbench command registry', () => {
  const disposers: Array<() => void> = []

  afterEach(() => {
    disposers.splice(0).forEach((dispose) => dispose())
  })

  it('exposes registered commands and executes the same registered action', () => {
    const run = vi.fn()
    disposers.push(
      registerWorkbenchAction({
        id: 'test.open-settings',
        title: 'Open settings',
        shortcut: 'Ctrl+,',
        run
      })
    )

    expect(getWorkbenchActionsSnapshot()).toContainEqual(
      expect.objectContaining({ id: 'test.open-settings', shortcut: 'Ctrl+,' })
    )
    expect(runWorkbenchAction('test.open-settings')).toBe(true)
    expect(run).toHaveBeenCalledOnce()
  })

  it('does not execute a command when its context is unavailable', () => {
    const run = vi.fn()
    disposers.push(
      registerWorkbenchAction({
        id: 'test.context-command',
        title: 'Context command',
        enabledWhen: () => false,
        run
      })
    )

    expect(runWorkbenchAction('test.context-command')).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })
})
