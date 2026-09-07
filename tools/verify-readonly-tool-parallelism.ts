import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const executor = readFileSync(
  'sidecars/Ola.Native.Worker/Modules/AgentRuntime/AgentRuntimeNativeToolExecutor.cs',
  'utf8'
)
const runtime = readFileSync(
  'sidecars/Ola.Native.Worker/Modules/AgentRuntime/OpenAIChatRuntime.cs',
  'utf8'
)

assert.match(executor, /return toolName is "Read" or "LS" or "Glob" or "Grep"/)
assert.match(executor, /AgentRuntimeSshToolExecutor\.ShouldRoute/)
assert.doesNotMatch(executor, /"Bash" or "Shell"[^\n]*parallel/i)
assert.match(runtime, /Task\.WhenAll\(batch\.Select/)
assert.match(runtime, /CanRunReadOnlyToolsInParallel/)
assert.match(runtime, /toolResults\.AddRange\(results\)/)

console.log('Read-only Worker parallelism verification passed')
