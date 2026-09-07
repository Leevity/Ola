import {
  canChaseTail,
  restorePrependScrollOffset,
  VIEWPORT,
  type ViewportMode
} from '../src/renderer/src/components/chat/message-list-viewport'

function expect(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const modes: ViewportMode[] = ['positioning', 'following', 'browsing']
expect(modes.length === 3, 'viewport mode contract changed unexpectedly')
expect(
  canChaseTail({ mode: 'following', streaming: true, userIntent: false }),
  'following stream should chase the tail'
)
expect(
  !canChaseTail({ mode: 'browsing', streaming: true, userIntent: false }),
  'browsing must never chase the tail'
)
expect(
  !canChaseTail({ mode: 'following', streaming: true, userIntent: true }),
  'explicit user intent must win over stream follow'
)
expect(
  restorePrependScrollOffset({
    previousScrollTop: 240,
    previousScrollHeight: 1_000,
    nextScrollHeight: 1_360
  }) === 600,
  'prepending history must preserve the visible offset'
)
expect(VIEWPORT.streamingBottomThreshold > VIEWPORT.staticBottomThreshold, 'stream threshold')
console.log('message-list viewport verification passed')
