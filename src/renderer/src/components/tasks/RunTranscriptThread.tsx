import * as React from 'react'
import type { UnifiedMessage } from '@renderer/lib/api/types'
import { TranscriptMessageList } from '@renderer/components/chat/TranscriptMessageList'

export function RunTranscriptThread({
  messages
}: {
  messages: UnifiedMessage[]
}): React.JSX.Element {
  return <TranscriptMessageList messages={messages} />
}
