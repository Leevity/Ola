import {
  canChaseTail,
  resolveViewportMode,
  restorePrependScrollOffset,
  shouldRequestOlderLoad,
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
expect(
  resolveViewportMode({
    previous: 'following',
    atBottom: false,
    isProgrammatic: false,
    userIntent: true
  }) === 'browsing',
  'a deliberate browse action must leave following mode'
)
expect(
  resolveViewportMode({
    previous: 'browsing',
    atBottom: true,
    isProgrammatic: false,
    userIntent: true
  }) === 'following',
  'returning to the physical bottom must restore following mode'
)
expect(
  !shouldRequestOlderLoad({
    intent: 'fill',
    hasOlder: true,
    loading: false,
    mode: 'following',
    messageCount: 4,
    fillPages: VIEWPORT.maxFillPages
  }),
  'fill loading must be bounded'
)
expect(
  shouldRequestOlderLoad({
    intent: 'visibility',
    hasOlder: true,
    loading: false,
    mode: 'browsing',
    messageCount: 0,
    fillPages: 0
  }),
  'an empty resident window must be allowed to restore visibility'
)
console.log('message-list viewport verification passed')
