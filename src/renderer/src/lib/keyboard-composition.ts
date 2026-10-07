type KeyboardCompositionState = {
  key: string
  isComposing?: boolean
  keyCode?: number
  nativeEvent?: { isComposing?: boolean; keyCode?: number }
}

const IME_COMMIT_WINDOW_MS = 100

export function isImeCommitKey(
  event: KeyboardCompositionState,
  lastCompositionEndAt = 0,
  now = performance.now()
): boolean {
  if (
    event.isComposing ||
    event.nativeEvent?.isComposing ||
    event.keyCode === 229 ||
    event.nativeEvent?.keyCode === 229 ||
    lastCompositionEndAt === Number.POSITIVE_INFINITY
  )
    return true
  return (
    event.key === 'Enter' &&
    lastCompositionEndAt > 0 &&
    now >= lastCompositionEndAt &&
    now - lastCompositionEndAt < IME_COMMIT_WINDOW_MS
  )
}
