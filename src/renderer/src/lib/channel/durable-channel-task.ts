/** ACK only after a channel task has settled successfully, so crashes can replay it. */
export async function completeDurableChannelTask(
  run: () => Promise<void>,
  acknowledge: () => void
): Promise<void> {
  await run()
  acknowledge()
}

/** Channel providers may return an empty ID (for example webhook sends), but must return a receipt. */
export function hasChannelDeliveryReceipt(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'messageId' in result &&
    typeof result.messageId === 'string'
  )
}
