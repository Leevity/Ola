import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { RuntimeClient } from './runtime-client'
import { readDesktopRuntimeConnection } from './desktop-connection'
import { startStandaloneRuntime } from './standalone'
import { ProtocolAdapter } from '../providers/protocol-adapter'
import { LocalModelTransport } from '../providers/transport'
import type { ModelProtocol } from '../../shared/runtime/model'
import { createAgentExecutor } from '../core/agent'
import { ToolExecutor } from '../tools/tool-executor'
import { selectExplicitTools } from '../tools/explicit-tools'
import { createLocalReadFileTool } from '../tools/local-read-file'
import { createLocalListDirectoryTool } from '../tools/local-list-directory'
import { createLocalGitStatusTool } from '../tools/local-git-status'
import { createLocalCreateFileTool } from '../tools/local-create-file'
import { createLocalWriteFileTool } from '../tools/local-write-file'
import { createLocalFindFilesTool, createLocalGlobFilesTool } from '../tools/local-find-files'
import { createLocalShellCommandTool } from '../tools/local-shell-command'
import {
  createLegacyBashTool,
  createLegacyEditTool,
  createLegacyGlobTool,
  createLegacyGrepTool,
  createLegacyListDirectoryTool,
  createLegacyReadTool,
  createLegacyWriteTool
} from '../tools/legacy-local-tools'
import {
  RuntimeError,
  TERMINAL_STATUSES,
  type RunRecord,
  type RunSnapshot,
  type RunSpec
} from '../../shared/runtime/contracts'
import {
  createLegacyRollbackDrill,
  createLegacyDatabaseHandoverSnapshot,
  verifyLegacyDatabaseHandoverSnapshot,
  verifyLegacyBusinessDatabaseContract
} from '../storage/legacy-database-handover'

const args = process.argv.slice(2)
function option(name: string): string | undefined {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
function hasFlag(name: string): boolean {
  return args.includes(name)
}
function requestedToolNames(): string[] | undefined {
  const raw = option('--tools')
  if (raw === undefined) return undefined
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  if (!names.length) throw new RuntimeError('INVALID_TOOL_SNAPSHOT')
  return names
}
async function main(): Promise<void> {
  const command = args[0]
  if (!command || command === 'help') {
    console.log(
      'Ola staged TS runtime (Node 24+, local model protocols)\n\nserve --data-dir <isolated-dir> --provider <id> --model <id> --base-url <url> [--api-key-env <name>] [--workspace-root <path>] [--allow-write] [--protocol openai-chat|openai-responses|anthropic|gemini|vertex-ai]\nrun [--data-dir <dir>] --provider <id> --model <id> --prompt-file <file> [--session <id>] [--tools name[,name…]]\nlist [--data-dir <dir>]\nwatch [--data-dir <dir>] --run <id>\ncancel [--data-dir <dir>] --run <id>\nbackup-legacy-db [--data-dir <dir>] [--source <data.db>] [--backup-dir <dir>]\nverify-legacy-handover --manifest <manifest.json>\ndrill-legacy-rollback --manifest <manifest.json> --restore-dir <isolated-dir>\n\nWithout --data-dir, CLI connects to the running desktop Runtime through its protected local descriptor. Keys stay in the service environment; do not pass keys as CLI arguments. --workspace-root registers confined tools, but each run must explicitly opt in through --tools. --allow-write additionally makes create_text_file and write_text_file available for unattended runs in that root. backup-legacy-db first verifies the legacy business-schema contract, then creates a writable handover copy plus an independent read-only rollback baseline; it does not stop the Native Worker or perform a database migration. verify-legacy-handover is a read-only check for a completed handover manifest. drill-legacy-rollback creates a separate writable copy of the immutable baseline without touching the live source.'
    )
    return
  }
  const directory = option('--data-dir')
  if (command === 'serve' && !directory) throw new RuntimeError('EXPLICIT_DATA_DIRECTORY_REQUIRED')
  const dataDirectory = resolve(
    directory ?? (process.env.OLA_DATA_DIR?.trim() || join(homedir(), '.ola'))
  )
  if (command === 'backup-legacy-db') {
    const sourcePath = resolve(option('--source') ?? join(dataDirectory, 'data.db'))
    const contract = await verifyLegacyBusinessDatabaseContract({ sourcePath })
    const snapshot = await createLegacyDatabaseHandoverSnapshot({
      sourcePath,
      backupDirectory: resolve(
        option('--backup-dir') ?? join(dataDirectory, 'backups', 'ts-handover')
      )
    })
    console.log(JSON.stringify({ contract, snapshot }, null, 2))
    return
  }
  if (command === 'verify-legacy-handover') {
    const manifestPath = option('--manifest')
    if (!manifestPath) throw new RuntimeError('LEGACY_DATABASE_HANDOVER_MANIFEST_REQUIRED')
    console.log(
      JSON.stringify(
        await verifyLegacyDatabaseHandoverSnapshot({ manifestPath: resolve(manifestPath) }),
        null,
        2
      )
    )
    return
  }
  if (command === 'drill-legacy-rollback') {
    const manifestPath = option('--manifest')
    const restoreDirectory = option('--restore-dir')
    if (!manifestPath) throw new RuntimeError('LEGACY_DATABASE_HANDOVER_MANIFEST_REQUIRED')
    if (!restoreDirectory) throw new RuntimeError('LEGACY_DATABASE_RESTORE_DIRECTORY_REQUIRED')
    console.log(
      JSON.stringify(
        await createLegacyRollbackDrill({
          manifestPath: resolve(manifestPath),
          restoreDirectory: resolve(restoreDirectory)
        }),
        null,
        2
      )
    )
    return
  }
  if (command === 'serve') {
    const provider = option('--provider'),
      model = option('--model'),
      baseUrl = option('--base-url')
    if (!provider || !model || !baseUrl) throw new RuntimeError('PROVIDER_CONFIGURATION_REQUIRED')
    const environmentKey = option('--api-key-env')
    const apiKey = environmentKey ? process.env[environmentKey] : undefined
    if (environmentKey && !apiKey) throw new RuntimeError('PROVIDER_AUTH_REQUIRED')
    const authorize = async (run: RunSpec): Promise<void> => {
      if (
        run.workspaceId !== 'local-personal' ||
        run.modelSource.kind !== 'local' ||
        run.modelSource.providerId !== provider ||
        run.modelSource.modelId !== model ||
        run.environmentId !== 'local'
      )
        throw new RuntimeError('MODEL_UNAVAILABLE')
    }
    const protocol = option('--protocol') ?? 'openai-chat'
    if (!['openai-chat', 'openai-responses', 'anthropic', 'gemini', 'vertex-ai'].includes(protocol))
      throw new RuntimeError('INVALID_MODEL_PROTOCOL')
    const adapter = new ProtocolAdapter(
      new LocalModelTransport(async (run) => {
        await authorize(run)
        return { baseUrl, model, apiKey, protocol: protocol as ModelProtocol }
      })
    )
    const workspaceRoot = option('--workspace-root')
    const allowWrite = hasFlag('--allow-write')
    if (allowWrite && !workspaceRoot) throw new RuntimeError('WORKING_DIRECTORY_REQUIRED')
    const definitions = workspaceRoot
      ? [
          createLocalReadFileTool(resolve(workspaceRoot)),
          createLocalListDirectoryTool(resolve(workspaceRoot)),
          createLocalFindFilesTool(resolve(workspaceRoot)),
          createLocalGlobFilesTool(resolve(workspaceRoot)),
          createLocalGitStatusTool(resolve(workspaceRoot)),
          createLegacyReadTool(resolve(workspaceRoot)),
          createLegacyListDirectoryTool(resolve(workspaceRoot)),
          createLegacyGlobTool(resolve(workspaceRoot)),
          createLegacyGrepTool(resolve(workspaceRoot)),
          ...(allowWrite
            ? [
                createLocalCreateFileTool(resolve(workspaceRoot)),
                createLocalWriteFileTool(resolve(workspaceRoot)),
                createLocalShellCommandTool(resolve(workspaceRoot)),
                createLegacyBashTool(resolve(workspaceRoot)),
                createLegacyWriteTool(resolve(workspaceRoot)),
                createLegacyEditTool(resolve(workspaceRoot))
              ]
            : [])
        ]
      : []
    const tools = async (run: RunSpec): Promise<ToolExecutor> =>
      new ToolExecutor(
        selectExplicitTools(definitions, run.toolNames),
        async (tool) => tool.effect === 'read' || allowWrite
      )
    const service = await startStandaloneRuntime({
      dataDirectory,
      execute: createAgentExecutor(adapter, tools),
      authorize,
      authority: { workspaceIds: async () => new Set(['local-personal']) }
    })
    console.log('Ola TS runtime ready')
    const stop = (): void => {
      void service.stop().then(
        () => {
          process.exitCode = 0
        },
        () => {
          process.exitCode = 1
        }
      )
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    return
  }
  const desktopDescriptorPath = process.env.OLA_DESKTOP_RUNTIME_DESCRIPTOR?.trim() || undefined
  const connection =
    (!directory && (await readDesktopRuntimeConnection(desktopDescriptorPath))) ||
    (JSON.parse(await readFile(join(dataDirectory, 'runtime-v2', 'connection.json'), 'utf8')) as {
      endpoint: string
      token: string
    })
  const client = new RuntimeClient()
  try {
    await client.connect(connection.endpoint, connection.token)
    if (command === 'list')
      console.log(
        JSON.stringify(await client.request('run.list', { workspaceId: 'local-personal' }), null, 2)
      )
    else if (command === 'run') {
      const promptFile = option('--prompt-file'),
        providerId = option('--provider'),
        modelId = option('--model')
      if (!promptFile || !providerId || !modelId)
        throw new RuntimeError('RUN_CONFIGURATION_REQUIRED')
      const id = randomUUID()
      const toolNames = requestedToolNames()
      const run = await client.request<RunRecord>('run.submit', {
        runId: id,
        requestId: id,
        traceId: id,
        taskId: id,
        workspaceId: 'local-personal',
        sessionId: option('--session') ?? id,
        environmentId: 'local',
        prompt: await readFile(promptFile, 'utf8'),
        ...(toolNames?.length ? { toolNames } : {}),
        unattended: true,
        modelSource: { kind: 'local', providerId, modelId }
      })
      console.log(run.runId)
    } else if (command === 'cancel')
      await client.request('run.cancel', { workspaceId: 'local-personal', runId: option('--run') })
    else if (command === 'watch') {
      let seq = 0
      for (;;) {
        const snapshot = await client.request<RunSnapshot | null>('run.snapshot', {
          workspaceId: 'local-personal',
          runId: option('--run'),
          afterSeq: seq
        })
        if (!snapshot) throw new RuntimeError('RUN_NOT_FOUND')
        for (const event of snapshot.events) {
          console.log(JSON.stringify(event))
          seq = event.seq
        }
        if (TERMINAL_STATUSES.has(snapshot.run.status) && seq >= snapshot.run.seq) break
        if (seq < snapshot.run.seq) continue
        await new Promise((r) => setTimeout(r, 100))
      }
    } else throw new RuntimeError('UNKNOWN_COMMAND')
  } finally {
    client.close()
  }
}
void main().catch((error) => {
  console.error(error instanceof RuntimeError ? error.code : 'RUNTIME_COMMAND_FAILED')
  process.exitCode = 1
})
