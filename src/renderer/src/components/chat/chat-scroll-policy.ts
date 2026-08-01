export function shouldCompensateTranscriptRowResize({
  itemEnd,
  scrollOffset,
  followingOutput
}: {
  itemEnd: number
  scrollOffset: number
  followingOutput: boolean
}): boolean {
  return !followingOutput && itemEnd < scrollOffset
}

export function preserveViewportOffsetAfterPrepend({
  previousScrollTop,
  previousScrollHeight,
  nextScrollHeight
}: {
  previousScrollTop: number
  previousScrollHeight: number
  nextScrollHeight: number
}): number {
  return Math.max(0, previousScrollTop + nextScrollHeight - previousScrollHeight)
}

export type ChatAutoScrollMode = 'off' | 'user' | 'stream'

export function resolveChatAutoScrollState(input: {
  mode: ChatAutoScrollMode
  distanceToBottom: number
  bottomThreshold: number
  previousOffset: number
  currentOffset: number
  correctionEpsilon: number
  isProgrammatic: boolean
  isOutputting: boolean
}): { mode: ChatAutoScrollMode; isAtBottom: boolean } {
  const scrolledUp = input.currentOffset < input.previousOffset - input.correctionEpsilon
  const scrolledDown = input.currentOffset > input.previousOffset
  if (scrolledUp && !input.isProgrammatic) return { mode: 'off', isAtBottom: false }

  let mode = input.mode
  if (
    input.distanceToBottom <= input.correctionEpsilon &&
    mode === 'off' &&
    scrolledDown &&
    !input.isProgrammatic
  ) {
    mode = input.isOutputting ? 'stream' : 'user'
  }
  const physicallyAtBottom = input.distanceToBottom <= input.bottomThreshold
  return {
    mode,
    isAtBottom: mode !== 'off' && (physicallyAtBottom || (input.isOutputting && mode === 'stream'))
  }
}
