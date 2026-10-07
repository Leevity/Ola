import { describe, expect, it, vi } from 'vitest'
import { focusAdjacentWorkspaceTab } from '../../src/renderer/src/lib/workbench/workspace-tab-navigation'

function tab() {
  return { focus: vi.fn(), click: vi.fn() }
}

describe('workspace tab keyboard navigation', () => {
  it('moves focus and activates the next tab, wrapping at both ends', () => {
    const tabs = [tab(), tab(), tab()]
    const preventDefault = vi.fn()

    expect(focusAdjacentWorkspaceTab('ArrowRight', tabs[0], tabs, preventDefault)).toBe(true)
    expect(tabs[1].focus).toHaveBeenCalledOnce()
    expect(tabs[1].click).toHaveBeenCalledOnce()
    expect(preventDefault).toHaveBeenCalledOnce()

    expect(focusAdjacentWorkspaceTab('ArrowLeft', tabs[0], tabs, preventDefault)).toBe(true)
    expect(tabs[2].focus).toHaveBeenCalledOnce()
    expect(tabs[2].click).toHaveBeenCalledOnce()
  })

  it('leaves other keys and tabs without a current focus target alone', () => {
    const tabs = [tab(), tab()]
    const preventDefault = vi.fn()

    expect(focusAdjacentWorkspaceTab('Enter', tabs[0], tabs, preventDefault)).toBe(false)
    expect(focusAdjacentWorkspaceTab('ArrowRight', null, tabs, preventDefault)).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(tabs[1].click).not.toHaveBeenCalled()
  })
})
