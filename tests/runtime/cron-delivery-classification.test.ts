import { describe, expect, it } from 'vitest'
import { classifyCronDeliveryResult } from '../../src/main/cron/cron-delivery-tracking'

describe('Cron delivery result classification', () => {
  it('separates confirmed, failed and unknown delivery outcomes', () => {
    expect(classifyCronDeliveryResult({ success: true })).toBe('sent')
    expect(classifyCronDeliveryResult({ messageId: 'message-1' })).toBe('sent')
    expect(classifyCronDeliveryResult({ success: false })).toBe('failed')
    expect(classifyCronDeliveryResult({ status: 'unknown' })).toBe('unknown')
    expect(classifyCronDeliveryResult({ success: true, error: 'rejected' })).toBe('unknown')
    expect(classifyCronDeliveryResult({ success: false, messageId: 'message-1' })).toBe('unknown')
  })
})
