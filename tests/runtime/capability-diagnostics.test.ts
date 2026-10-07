import { describe, expect, it } from 'vitest'
import { buildCapabilityDiagnosticSnapshot } from '../../src/renderer/src/lib/capability-diagnostics'

describe('capability diagnostic export', () => {
  it('exports aggregate counts and excludes identifiers, configuration, paths, and errors', () => {
    const snapshot = buildCapabilityDiagnosticSnapshot({
      generatedAt: new Date('2026-10-01T10:00:00.000Z'),
      locale: 'zh-CN',
      providerHealth: {
        loaded: true,
        failed: false,
        providers: [
          {
            providerKey: 'secret-provider-id',
            status: 'degraded',
            consecutiveFailures: 2,
            totalRequests: 5,
            successfulRequests: 3,
            failedRequests: 2,
            averageLatencyMs: 120,
            lastError: 'secret-api-key and C:/private/project',
            updatedAt: 10
          }
        ]
      },
      skills: { loaded: true, failed: false, installedCount: 2 },
      builtinPlugins: { loaded: true, total: 4, enabled: 2, needsSetup: 1 },
      extensions: {
        loaded: true,
        failed: false,
        items: [
          {
            id: 'secret-extension-id',
            enabled: true,
            manifest: { name: 'secret-extension-name' }
          } as never
        ]
      },
      mcp: {
        loaded: true,
        failed: false,
        statusChecked: true,
        statusCheckFailed: false,
        servers: [
          { id: 'secret-mcp-id', name: 'secret-mcp-name', enabled: true } as never,
          { id: 'disabled-mcp', name: 'disabled', enabled: false } as never
        ],
        statuses: { 'secret-mcp-id': 'connected' }
      },
      channels: {
        loaded: true,
        failed: false,
        statusChecked: true,
        statusCheckFailedCount: 0,
        items: [
          {
            id: 'secret-channel-id',
            name: 'secret-channel-name',
            config: { token: 'secret-channel-token' },
            enabled: true
          } as never
        ],
        statuses: { 'secret-channel-id': 'running' }
      }
    })

    const serialized = JSON.stringify(snapshot)
    expect(serialized).toContain('"degraded":1')
    expect(serialized).toContain('"needsSetup":1')
    expect(serialized).toContain('"builtinPlugins"')
    expect(serialized).toContain('"connected":1')
    expect(serialized).toContain('"running":1')
    expect(serialized).toContain('aggregate_only')
    expect(serialized).not.toContain('secret-provider-id')
    expect(serialized).not.toContain('secret-mcp-id')
    expect(serialized).not.toContain('secret-mcp-name')
    expect(serialized).not.toContain('secret-channel-token')
    expect(serialized).not.toContain('secret-extension-name')
    expect(serialized).not.toContain('secret-api-key')
    expect(serialized).not.toContain('C:/private/project')
  })
})
