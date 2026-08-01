export function hasCompleteAgentRunJournal(firstSeq: number): boolean {
  return Number.isSafeInteger(firstSeq) && firstSeq >= 0 && firstSeq <= 1
}

export function resolveAgentRunAttachSequence(input: {
  firstSeq: number
  lastSeq: number
  receiverLastSeq?: number
}): number {
  if (input.receiverLastSeq !== undefined) return input.receiverLastSeq
  return hasCompleteAgentRunJournal(input.firstSeq) ? -1 : input.lastSeq
}
