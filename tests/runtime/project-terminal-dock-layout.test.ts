import { describe, expect, it } from 'vitest'
import {
  getProjectTerminalDockLayout,
  getMaxProjectWorkspaceLeftWidth
} from '../../src/renderer/src/lib/workbench/project-terminal-dock-layout'

describe('project terminal dock responsive layout', () => {
  it('keeps the terminal at the bottom when the workspace cannot fit both panes', () => {
    expect(
      getProjectTerminalDockLayout({
        workspaceWidth: 663,
        leftWidth: 300,
        terminalOpen: true,
        preferredArea: 'right'
      })
    ).toEqual({ canMoveRight: false, effectiveArea: 'bottom', effectiveLeftWidth: 300 })
  })

  it('uses the right dock at the minimum width and preserves minimum pane widths', () => {
    expect(
      getProjectTerminalDockLayout({
        workspaceWidth: 664,
        leftWidth: 300,
        terminalOpen: true,
        preferredArea: 'right'
      })
    ).toEqual({ canMoveRight: true, effectiveArea: 'right', effectiveLeftWidth: 220 })
  })

  it('temporarily falls back to bottom while closed or narrow, then restores the preference', () => {
    expect(
      getProjectTerminalDockLayout({
        workspaceWidth: 900,
        leftWidth: 300,
        terminalOpen: false,
        preferredArea: 'right'
      }).effectiveArea
    ).toBe('bottom')
    expect(
      getProjectTerminalDockLayout({
        workspaceWidth: 900,
        leftWidth: 300,
        terminalOpen: true,
        preferredArea: 'right'
      }).effectiveArea
    ).toBe('right')
  })

  it('limits explorer resizing so it cannot steal space reserved for the right dock', () => {
    expect(getMaxProjectWorkspaceLeftWidth(720, 'right')).toBe(276)
    expect(getMaxProjectWorkspaceLeftWidth(1000, 'right')).toBe(520)
    expect(getMaxProjectWorkspaceLeftWidth(720, 'bottom')).toBe(520)
  })
})
