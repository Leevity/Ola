import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const manager = await readFile('src/main/ipc/sidecar-manager.ts', 'utf8')
const receiver = await readFile('src/renderer/src/lib/ipc/agent-stream-receiver.ts', 'utf8')
const routing = await readFile('src/renderer/src/lib/ipc/messagepack-channel-routing.ts', 'utf8')
const runtime = await readFile('src/main/ipc/native-agent-runtime.ts', 'utf8')
const bridge = await readFile('src/renderer/src/lib/ipc/agent-bridge.ts', 'utf8')
const workerModule = await readFile(
  'sidecars/Ola.Native.Worker/Modules/AgentRuntime/AgentRuntimeModule.cs',
  'utf8'
)
const workerTools = await readFile(
  'sidecars/Ola.Native.Worker/Modules/AgentRuntime/AgentRuntimeTools.cs',
  'utf8'
)
const workerModels = await readFile(
  'sidecars/Ola.Native.Worker/Modules/AgentRuntime/AgentRuntimeModels.cs',
  'utf8'
)
const workerJson = await readFile(
  'sidecars/Ola.Native.Worker/Serialization/WorkerJsonContext.cs',
  'utf8'
)
const packageJson = await readFile('package.json', 'utf8')

assert.match(manager, /const AGENT_STREAM_REPLAY_MAX_FRAMES = 512/)
assert.match(manager, /const AGENT_STREAM_REPLAY_TERMINAL_TTL_MS = 60_000/)
assert.match(manager, /const agentStreamReplayCache = new Map<string, CachedAgentStreamRun>\(\)/)
assert.match(manager, /cacheSentAgentStreamFrames\(targetWindow, batch\.frames\)/)
assert.match(manager, /cacheSentAgentStreamFrames\(targetWindow, \[bytes\]\)/)
assert.match(manager, /registerMessagePackInvokeHandler<AgentStreamReplayArgs>\(/)
assert.match(manager, /'agent:stream-replay'/)
assert.match(manager, /sourceWindow\.id !== cached\.ownerWindowId/)
assert.match(manager, /reason: 'not_owner'/)
assert.match(manager, /reason: 'gap_not_buffered'/)
assert.match(manager, /frame\.seq > afterSeq && frame\.seq <= untilSeq/)
assert.match(manager, /frames\.at\(-1\)\?\.seq === untilSeq/)

assert.match(routing, /'agent:stream-replay'/)
assert.match(routing, /'agent:run-snapshot'/)
assert.match(manager, /'agent:run-snapshot'/)
assert.match(manager, /isAgentRunOwnedBy\(event, runId, runWindowIds\)/)
assert.match(manager, /reason: 'not_owner'/)
assert.match(runtime, /async runSnapshot\(runId: string\)/)
assert.match(runtime, /'agent\/run-snapshot'/)
assert.match(runtime, /generation: worker\.generation/)
assert.match(bridge, /async getAgentRunSnapshot\(runId: string\)/)
assert.match(
  workerModule,
  /context\.Register\(AgentRuntimeContract\.RunSnapshotRoute, AgentRuntimeTools\.RunSnapshot\)/
)
assert.match(workerTools, /public static WorkerResponse RunSnapshot\(JsonElement parameters\)/)
assert.match(workerTools, /state\?\.LastSeq \?\? 0/)
assert.match(workerTools, /public long LastSeq => Volatile\.Read\(ref seq\)/)
assert.match(workerModels, /internal sealed record AgentRuntimeRunSnapshotResult\(/)
assert.match(workerJson, /\[JsonSerializable\(typeof\(AgentRuntimeRunSnapshotResult\)\)\]/)
assert.match(receiver, /private processingChains = new Map<string, Promise<void>>\(\)/)
assert.match(receiver, /this\.queueEnvelope\(envelope, metrics\)/)
assert.match(receiver, /await this\.requestReplay\(envelope\.runId, lastSeq, envelope\.seq - 1\)/)
assert.match(receiver, /if \(lastSeq !== undefined && envelope\.seq <= lastSeq\)/)
assert.match(receiver, /private emitRecoveryUnavailable\(/)
assert.match(receiver, /Replay unavailable/)
assert.match(receiver, /stream_recovery_unavailable/)
assert.match(receiver, /Agent stream was interrupted and could not be recovered/)
assert.match(receiver, /this\.lastSeqByRun\.delete\(envelope\.runId\)/)
assert.match(receiver, /private unrecoverableRunIds = new Set<string>\(\)/)
assert.match(receiver, /if \(this\.unrecoverableRunIds\.has\(envelope\.runId\)\) return/)
assert.match(receiver, /while \(this\.unrecoverableRunIds\.size > 256\)/)
assert.match(packageJson, /"verify:agent-stream-replay"/)
assert.match(packageJson, /npm run verify:agent-stream-replay/)

console.log('agent stream replay verification passed')
