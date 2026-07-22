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
