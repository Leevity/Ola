export interface WorkspaceTabTarget {
  focus(): void
  click(): void
}

export function focusAdjacentWorkspaceTab(
  key: string,
  activeElement: WorkspaceTabTarget | null,
  tabs: WorkspaceTabTarget[],
  preventDefault: () => void
): boolean {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return false
  const index = tabs.indexOf(activeElement as WorkspaceTabTarget)
  if (index < 0 || tabs.length < 2) return false

  preventDefault()
  const direction = key === 'ArrowRight' ? 1 : -1
  const next = tabs[(index + direction + tabs.length) % tabs.length]
  next?.focus()
  next?.click()
  return true
}
