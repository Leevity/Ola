import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createExtensionRuntimeTools } from '../../src/main/extensions/extension-runtime-tools'
import { ToolExecutor } from '../../src/runtime/tools/tool-executor'
import { RunJournal } from '../../src/runtime/storage/run-journal'
import type { RunSpec } from '../../src/shared/runtime/contracts'
import type { ExtensionManifest } from '../../src/shared/extension-types'

const run: RunSpec = {
  runId: 'extension-http-run',
  taskId: 'task-1',
  requestId: 'request-1',
  traceId: 'trace-1',
  sessionId: 'session-1',
  workspaceId: 'local-personal',
  environmentId: 'local',
  modelSource: { kind: 'local', providerId: 'fixture', modelId: 'fixture' },
  prompt: 'Fetch a report',
  unattended: false
}

it('records only a successful declared HTTP Extension artifact from a local service', async () => {
  const server = createServer((request, response) => {
    const success = request.url === '/ok'
    response.writeHead(success ? 200 : 503, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        report: {
          url: `https://reports.example.test/${success ? 'ready' : 'failed'}`,
          title: success ? 'Ready report' : 'Failed report'
        }
      })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`
    const manifest: ExtensionManifest = {
      schemaVersion: 1,
      id: 'report-fixture',
      name: 'Report fixture',
      version: '1',
      permissions: { network: [`${baseUrl}/*`] },
      tools: ['ok', 'fail'].map((name) => ({
        name,
        description: `${name} report`,
        kind: 'http' as const,
        readOnly: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        http: { method: 'GET', url: `${baseUrl}/${name}` },
        artifact: {
          kind: 'link' as const,
          urlPointer: '/report/url',
          titlePointer: '/report/title'
        }
      }))
    }
    const tools = await createExtensionRuntimeTools(
      {
        getRuntime: async () => ({ id: manifest.id, enabled: true, manifest, config: {} })
      } as never,
      [manifest.id]
    )
    const executor = new ToolExecutor(tools, async () => true)
    const events: Array<{ type: string; data: unknown }> = []
    const results = await executor.executeAll(
      [
        { id: 'ok-call', name: 'extension__report-fixture__ok', input: {} },
        { id: 'fail-call', name: 'extension__report-fixture__fail', input: {} }
      ],
      { run, signal: new AbortController().signal },
      async (type, data) => {
        events.push({ type, data })
      }
    )
    expect(results.map((result) => result.isError ?? false)).toEqual([false, true])
    expect(events.filter((event) => event.type === 'artifact.registered')).toEqual([
      {
        type: 'artifact.registered',
        data: {
          toolCallId: 'ok-call',
          kind: 'link',
          transport: 'remote',
          url: 'https://reports.example.test/ready',
          title: 'Ready report'
        }
      }
    ])

    const directory = await mkdtemp(join(tmpdir(), 'ola-extension-artifact-'))
    let journal: RunJournal | undefined
    try {
      const databasePath = join(directory, 'runs.db')
      journal = new RunJournal(databasePath)
      await journal.create(run)
      for (const event of events) {
        await journal.append(run.runId, run.workspaceId, event.type, event.data)
      }
      await journal.transition(run.runId, run.workspaceId, ['queued'], 'completed')
      await journal.close()
      journal = undefined

      const reopened = new RunJournal(databasePath)
      journal = reopened
      const artifacts = await reopened.artifacts(run.workspaceId)
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0]).toMatchObject({
        runId: run.runId,
        data: { toolCallId: 'ok-call', url: 'https://reports.example.test/ready' }
      })
      expect(await reopened.artifacts('other-workspace')).toEqual([])
      expect(
        (await reopened.snapshot(run.runId, run.workspaceId))?.events.some(
          (event) =>
            event.type === 'tool.result' &&
            (event.data as { id?: string; isError?: boolean }).id === 'fail-call' &&
            (event.data as { isError?: boolean }).isError === true
        )
      ).toBe(true)
      await expect(
        reopened.hideArtifact('other-workspace', run.runId, artifacts[0].seq)
      ).rejects.toThrow('ARTIFACT_NOT_FOUND')
      await reopened.hideArtifact(run.workspaceId, run.runId, artifacts[0].seq)
      expect(await reopened.artifacts(run.workspaceId)).toEqual([])
      await reopened.close()
      journal = undefined

      const afterHideRestart = new RunJournal(databasePath)
      journal = afterHideRestart
      expect(await afterHideRestart.artifacts(run.workspaceId)).toEqual([])
      expect(
        (await afterHideRestart.snapshot(run.runId, run.workspaceId))?.events.some(
          (event) => event.type === 'artifact.registered' && event.seq === artifacts[0].seq
        )
      ).toBe(true)
    } finally {
      await journal?.close()
      const tempRoot = resolve(tmpdir())
      const resolvedDirectory = resolve(directory)
      if (resolvedDirectory.startsWith(`${tempRoot}${sep}`))
        await rm(resolvedDirectory, { recursive: true, force: true })
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
