import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolExecutor, type ToolDefinition } from '../../src/runtime/tools/tool-executor'
import { createLocalShellCommandTool } from '../../src/runtime/tools/local-shell-command'
import type { RunSpec } from '../../src/shared/runtime/contracts'

const run: RunSpec = {
  runId: 'run-1',
  taskId: 'runtime-task-1',
  requestId: 'request-1',
  traceId: 'trace-1',
  sessionId: 'session-1',
  workspaceId: 'local-personal',
  environmentId: 'local',
  modelSource: { kind: 'local', providerId: 'local', modelId: 'model' },
  prompt: 'Create a file',
  unattended: false
}

function definition(name: string, output: unknown, fails = false): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    effect: 'write',
    validate: (input) => input,
    resources: async () => ['/workspace/report.md'],
    execute: async () => {
      if (fails) throw new Error('write failed')
      return output
    }
  }
}

describe('runtime artifact events', () => {
  it('registers only confirmed file writes with the tool call identity', async () => {
    const events: Array<{ type: string; data: unknown }> = []
    const executor = new ToolExecutor(
      [
        definition('Write', { path: 'report.md', bytes: 12 }),
        definition('Edit', { path: 'edited.md', replaced: true }),
        definition('NotebookEdit', { path: 'analysis.ipynb', replaced: true }),
        definition('run_shell_command', { path: 'unverified.md' }),
        definition('write_text_file', { path: 'failed.md' }, true)
      ],
      async () => true
    )
    const calls = [
      { id: 'write-1', name: 'Write', input: {} },
      { id: 'edit-1', name: 'Edit', input: {} },
      { id: 'notebook-edit-1', name: 'NotebookEdit', input: {} },
      { id: 'shell-1', name: 'run_shell_command', input: {} },
      { id: 'failed-1', name: 'write_text_file', input: {} }
    ]
    await executor.executeAll(
      calls,
      { run, signal: new AbortController().signal },
      async (type, data) => {
        events.push({ type, data })
      }
    )
    expect(events.filter((event) => event.type === 'artifact.registered')).toEqual([
      {
        type: 'artifact.registered',
        data: {
          toolCallId: 'write-1',
          kind: 'file',
          transport: 'local',
          path: '/workspace/report.md',
          operation: 'create'
        }
      },
      {
        type: 'artifact.registered',
        data: {
          toolCallId: 'edit-1',
          kind: 'file',
          transport: 'local',
          path: '/workspace/report.md',
          operation: 'modify'
        }
      },
      {
        type: 'artifact.registered',
        data: {
          toolCallId: 'notebook-edit-1',
          kind: 'file',
          transport: 'local',
          path: '/workspace/report.md',
          operation: 'modify'
        }
      }
    ])
  })

  it('does not label an SSH file resource as a local artifact', async () => {
    const events: Array<{ type: string; data: unknown }> = []
    const remoteWrite: ToolDefinition = {
      ...definition('Write', { success: true, path: '/remote/report.md' }),
      resources: async () => ['ssh:team:connection']
    }
    const executor = new ToolExecutor([remoteWrite], async () => true)
    await executor.executeAll(
      [{ id: 'remote-write', name: 'Write', input: {} }],
      { run, signal: new AbortController().signal },
      async (type, data) => {
        events.push({ type, data })
      }
    )
    expect(events.filter((event) => event.type === 'artifact.registered')).toEqual([])
  })

  it('registers a verified shell output after a successful command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-shell-event-'))
    try {
      const events: Array<{ type: string; data: unknown }> = []
      const executor = new ToolExecutor([createLocalShellCommandTool(root)], async () => true)
      await executor.executeAll(
        [
          {
            id: 'shell-write',
            name: 'run_shell_command',
            input: {
              command:
                process.platform === 'win32'
                  ? 'echo hello>report.txt'
                  : 'printf hello > report.txt',
              outputFiles: ['report.txt']
            }
          }
        ],
        { run, signal: new AbortController().signal },
        async (type, data) => {
          events.push({ type, data })
        }
      )
      expect(events.filter((event) => event.type === 'artifact.registered')).toEqual([
        {
          type: 'artifact.registered',
          data: {
            toolCallId: 'shell-write',
            kind: 'file',
            transport: 'local',
            path: join(root, 'report.txt'),
            operation: 'create'
          }
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('registers a declared extension link artifact with its run and tool identity', async () => {
    const events: Array<{ type: string; data: unknown }> = []
    const extensionTool = definition('extension_example__report', {
      __olaExtensionResult: true,
      extensionId: 'example',
      artifacts: [
        {
          kind: 'link',
          url: 'https://reports.example.com/quarterly',
          title: 'Quarterly report'
        },
        { kind: 'link', url: 'javascript:alert(1)', title: 'Unsafe link' }
      ]
    })
    const executor = new ToolExecutor([extensionTool], async () => true)
    await executor.executeAll(
      [{ id: 'extension-call-1', name: extensionTool.name, input: {} }],
      { run, signal: new AbortController().signal },
      async (type, data) => {
        events.push({ type, data })
      }
    )
    expect(events.filter((event) => event.type === 'artifact.registered')).toEqual([
      {
        type: 'artifact.registered',
        data: {
          toolCallId: 'extension-call-1',
          kind: 'link',
          transport: 'remote',
          url: 'https://reports.example.com/quarterly',
          title: 'Quarterly report'
        }
      }
    ])
  })

  it('marks a failed extension HTTP result as an error without registering its link', async () => {
    const events: Array<{ type: string; data: unknown }> = []
    const extensionTool = definition('extension_example__failed', {
      __olaExtensionResult: true,
      extensionId: 'example',
      data: { ok: false, status: 503 },
      artifacts: [
        { kind: 'link', url: 'https://reports.example.com/failed', title: 'Failed report' }
      ]
    })
    const executor = new ToolExecutor([extensionTool], async () => true)
    const results = await executor.executeAll(
      [{ id: 'extension-failed-1', name: extensionTool.name, input: {} }],
      { run, signal: new AbortController().signal },
      async (type, data) => {
        events.push({ type, data })
      }
    )
    expect(results[0].isError).toBe(true)
    expect(events.filter((event) => event.type === 'artifact.registered')).toEqual([])
  })

  it('records verified host-extracted SSH artifacts without treating them as local files', async () => {
    const events: Array<{ type: string; data: unknown }> = []
    const remoteWrite: ToolDefinition = {
      ...definition('Write', { success: true, path: '/remote/report.pdf' }),
      resources: async () => ['ssh:team-a:connection-a'],
      artifacts: async (output) => {
        expect(output).toMatchObject({ success: true, path: '/remote/report.pdf' })
        return [
          {
            kind: 'file',
            transport: 'ssh',
            connectionId: 'connection-a',
            path: '/remote/report.pdf',
            operation: 'create'
          }
        ]
      }
    }
    const executor = new ToolExecutor([remoteWrite], async () => true)
    await executor.executeAll(
      [{ id: 'ssh-write-1', name: 'Write', input: {} }],
      { run, signal: new AbortController().signal },
      async (type, data) => {
        events.push({ type, data })
      }
    )
    expect(events.filter((event) => event.type === 'artifact.registered')).toEqual([
      {
        type: 'artifact.registered',
        data: {
          toolCallId: 'ssh-write-1',
          kind: 'file',
          transport: 'ssh',
          connectionId: 'connection-a',
          path: '/remote/report.pdf',
          operation: 'create'
        }
      }
    ])
  })

  it('does not register a partial shell file when the command exits with an error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-shell-event-'))
    try {
      const events: Array<{ type: string; data: unknown }> = []
      const executor = new ToolExecutor([createLocalShellCommandTool(root)], async () => true)
      const results = await executor.executeAll(
        [
          {
            id: 'shell-failed',
            name: 'run_shell_command',
            input: {
              command:
                process.platform === 'win32'
                  ? 'echo partial>partial.txt & exit /b 1'
                  : 'printf partial > partial.txt; exit 1',
              outputFiles: ['partial.txt']
            }
          }
        ],
        { run, signal: new AbortController().signal },
        async (type, data) => {
          events.push({ type, data })
        }
      )
      expect(results[0].output).toMatchObject({ exitCode: 1, artifacts: [] })
      expect(events.filter((event) => event.type === 'artifact.registered')).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps generated image artifacts inside their workspace directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-image-event-'))
    const outside = await mkdtemp(join(tmpdir(), 'ola-image-outside-'))
    try {
      const insidePath = join(root, 'inside.png')
      const outsidePath = join(outside, 'outside.png')
      await writeFile(insidePath, 'png')
      await writeFile(outsidePath, 'png')
      const imageTool: ToolDefinition = {
        ...definition(
          'ImageGenerate',
          JSON.stringify({
            __olaImageResult: true,
            images: [
              { filePath: insidePath, mediaType: 'image/png' },
              { filePath: outsidePath, mediaType: 'image/png' },
              { filePath: join(root, 'missing.png'), mediaType: 'image/png' }
            ]
          })
        ),
        resources: async () => [root]
      }
      const events: Array<{ type: string; data: unknown }> = []
      const executor = new ToolExecutor([imageTool], async () => true)
      await executor.executeAll(
        [{ id: 'image-1', name: 'ImageGenerate', input: {} }],
        { run, signal: new AbortController().signal },
        async (type, data) => {
          events.push({ type, data })
        }
      )
      expect(events.filter((event) => event.type === 'artifact.registered')).toEqual([
        {
          type: 'artifact.registered',
          data: {
            toolCallId: 'image-1',
            kind: 'file',
            transport: 'local',
            path: insidePath,
            operation: 'create',
            mediaType: 'image/png'
          }
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
