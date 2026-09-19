import { describe, expect, it } from 'vitest'
import {
  BUILTIN_BROWSER_PARTITION,
  browserPartitionForWorkspace,
  isBuiltInBrowserPartition
} from '../../src/shared/browser-plugin'

describe('workspace browser partitions', () => {
  it('keeps the historical local partition for existing personal browser data', () => {
    expect(browserPartitionForWorkspace('local-personal')).toBe(BUILTIN_BROWSER_PARTITION)
  })

  it('isolates team identifiers while safely encoding partition separators', () => {
    expect(browserPartitionForWorkspace('team-a')).not.toBe(browserPartitionForWorkspace('team-b'))
    expect(browserPartitionForWorkspace('team/a')).toBe(`${BUILTIN_BROWSER_PARTITION}-team%2Fa`)
  })

  it('recognizes only Ola-managed workspace partitions for webview attachment', () => {
    expect(isBuiltInBrowserPartition(BUILTIN_BROWSER_PARTITION)).toBe(true)
    expect(isBuiltInBrowserPartition(browserPartitionForWorkspace('team-a'))).toBe(true)
    expect(isBuiltInBrowserPartition('persist:another-app')).toBe(false)
  })
})
