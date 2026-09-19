import { describe, expect, it } from 'vitest'
import {
  captureWorkspaceLayout,
  getLayoutWindowScope,
  isWorkspaceLayoutSnapshot,
  restoreWorkspaceLayout,
  workspaceLayoutStorageKey
} from '../../src/renderer/src/lib/workbench/workspace-layout'

describe('workspace layout persistence', () => {
  const layout = {
    leftSidebarOpen: false,
    leftSidebarWidth: 360,
    rightPanelOpen: true,
    rightPanelWidth: 420,
    workingFolderSheetOpen: true,
    workingFolderPanelWidth: 480,
    conversationPanelFullWidth: true
  }

  it('captures and restores a valid workspace-local layout', () => {
    expect(captureWorkspaceLayout(layout)).toEqual(layout)
    expect(restoreWorkspaceLayout(layout)).toEqual(layout)
  })

  it('uses a stable logical window scope in each workspace key', () => {
    expect(getLayoutWindowScope('?layoutWindowScope=session%3Aabc')).toBe('session:abc')
    expect(getLayoutWindowScope('?appView=session')).toBe('primary')
    expect(workspaceLayoutStorageKey('local-personal', 'primary')).toBe(
      'window:primary:workspace:local-personal'
    )
    expect(workspaceLayoutStorageKey('team/A', 'session:abc')).toBe(
      'window:session%3Aabc:workspace:team%2FA'
    )
  })

  it('normalizes persisted widths again when the layout is restored', () => {
    expect(
      restoreWorkspaceLayout({ ...layout, leftSidebarWidth: 1, workingFolderPanelWidth: 9999 })
    ).toMatchObject({ leftSidebarWidth: 272, workingFolderPanelWidth: 560 })
  })

  it.each([
    null,
    {},
    { ...layout, rightPanelWidth: '420' },
    { ...layout, leftSidebarWidth: Number.NaN },
    { ...layout, rightPanelWidth: Number.POSITIVE_INFINITY }
  ])('rejects malformed persisted layout %#', (value) => {
    expect(isWorkspaceLayoutSnapshot(value)).toBe(false)
    expect(restoreWorkspaceLayout(value)).toBeNull()
  })
})
