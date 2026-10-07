import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createImageRuntimeTool } from '../../src/main/runtime/image-runtime-tool'
import { hydrateProviderMainMirror } from '../../src/main/providers/provider-main-store'
import { PROVIDER_STORE_KEY } from '../../src/shared/provider-contract'
import { ToolExecutor, type ToolContext } from '../../src/runtime/tools/tool-executor'
import type { RunSpec } from '../../src/shared/runtime/contracts'

vi.mock('../../src/main/remote/account-client', () => ({
  loadManagedModelResources: vi.fn(async () => [
    { id: 'managed-image-resource', model: 'account-image-model', category: 'image', enabled: true }
  ]),
  openManagedModelRequest: vi.fn(
    async () =>
      new Response(
        JSON.stringify({ data: [{ b64_json: Buffer.from('managed-png').toString('base64') }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }
      )
  )
}))

const originalFetch = globalThis.fetch
const originalDataRoot = process.env.OLA_E2E_DATA_ROOT
let testDataRoot: string

function run(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: 'image-run',
    taskId: 'image-task',
    requestId: 'request',
    traceId: 'trace',
    sessionId: 'session',
    workspaceId: 'local-personal',
    environmentId: 'local',
    modelSource: { kind: 'local', providerId: 'image-provider', modelId: 'image-model' },
    prompt: 'generate',
    toolNames: ['ImageGenerate'],
    unattended: false,
    ...overrides
  }
}

function context(): ToolContext {
  return { run: run(), signal: new AbortController().signal }
}

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (testDataRoot) await rm(testDataRoot, { recursive: true, force: true })
  testDataRoot = ''
  if (originalDataRoot === undefined) delete process.env.OLA_E2E_DATA_ROOT
  else process.env.OLA_E2E_DATA_ROOT = originalDataRoot
  vi.restoreAllMocks()
})

describe('TS ImageGenerate runtime tool', () => {
  it('validates bounds, calls the Main provider and saves generated output metadata', async () => {
    testDataRoot = await mkdtemp(join(tmpdir(), 'ola-image-runtime-'))
    await writeFile(join(testDataRoot, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
    process.env.OLA_E2E_DATA_ROOT = testDataRoot
    hydrateProviderMainMirror({
      [PROVIDER_STORE_KEY]: {
        providers: [
          {
            id: 'image-provider',
            name: 'Image Provider',
            type: 'openai-image',
            baseUrl: 'https://images.example.test/v1',
            apiKey: 'secret',
            enabled: true,
            models: [{ id: 'image-model', type: 'openai-image', enabled: true }]
          }
        ],
        activeImageProviderId: 'image-provider',
        activeImageModelId: 'image-model'
      }
    })
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ b64_json: Buffer.from('png').toString('base64') }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        )
    ) as typeof fetch

    const tool = createImageRuntimeTool()
    expect(() => tool.validate({ prompt: '', count: 1 })).toThrow('INVALID_TOOL_INPUT')
    const events: Array<{ type: string; data: unknown }> = []
    const executor = new ToolExecutor([tool], async () => true)
    const result = await executor.executeAll(
      [{ id: 'image-tool-call', name: 'ImageGenerate', input: { prompt: 'a mascot', count: 1 } }],
      context(),
      async (type, data) => {
        events.push({ type, data })
      }
    )
    const parsed = JSON.parse(result[0].output as string) as {
      __olaImageResult: boolean
      images: Array<{ filePath: string; mediaType: string }>
    }
    expect(parsed.__olaImageResult).toBe(true)
    expect(parsed.images).toHaveLength(1)
    expect(parsed.images[0].mediaType).toBe('image/png')
    expect(events.filter((event) => event.type === 'artifact.registered')).toEqual([
      {
        type: 'artifact.registered',
        data: {
          toolCallId: 'image-tool-call',
          kind: 'file',
          transport: 'local',
          path: parsed.images[0].filePath,
          operation: 'create',
          mediaType: 'image/png'
        }
      }
    ])
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://images.example.test/v1/images/generations',
      expect.objectContaining({ method: 'POST' })
    )
    await rm(testDataRoot, { recursive: true, force: true })
  })

  it('rejects models that are not image models', async () => {
    hydrateProviderMainMirror({
      [PROVIDER_STORE_KEY]: {
        providers: [
          {
            id: 'image-provider',
            name: 'Text Provider',
            type: 'openai-chat',
            baseUrl: 'https://text.example.test/v1',
            apiKey: 'secret',
            enabled: true,
            models: [{ id: 'image-model', type: 'openai-chat', enabled: true }]
          }
        ],
        activeImageProviderId: 'image-provider',
        activeImageModelId: 'image-model'
      }
    })
    await expect(
      createImageRuntimeTool().execute(
        createImageRuntimeTool().validate({ prompt: 'a mascot' }),
        context()
      )
    ).rejects.toThrow('MODEL_UNAVAILABLE')
  })

  it('uses the independent managed image binding instead of the chat model', async () => {
    testDataRoot = await mkdtemp(join(tmpdir(), 'ola-managed-image-runtime-'))
    await writeFile(join(testDataRoot, '.ola-e2e-root'), 'OLA_ISOLATED_E2E_ROOT\n')
    process.env.OLA_E2E_DATA_ROOT = testDataRoot

    const tool = createImageRuntimeTool()
    const result = await tool.execute(tool.validate({ prompt: 'a managed mascot' }), {
      run: run({
        workspaceId: 'managed-workspace',
        modelSource: {
          kind: 'ola-personal',
          workspaceId: 'managed-workspace',
          resourceId: 'chat-resource'
        },
        imageModelSource: {
          kind: 'ola-personal',
          workspaceId: 'managed-workspace',
          resourceId: 'managed-image-resource'
        }
      }),
      signal: new AbortController().signal
    })
    const parsed = JSON.parse(result as string) as { images: Array<{ filePath: string }> }
    expect(parsed.images).toHaveLength(1)
    expect((await readFile(parsed.images[0].filePath)).toString()).toBe('managed-png')
  })
})
