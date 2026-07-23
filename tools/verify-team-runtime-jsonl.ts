import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  'sidecars/Ola.Native.Worker/Modules/AgentRuntime/AgentRuntimeTeamRuntimeStore.cs',
  'utf8'
)

assert.match(source, /MessagesFileName = "messages\.jsonl"/)
assert.match(source, /LegacyMessagesFileName = "messages\.json"/)
assert.match(source, /AppendJsonlMessage\(teamName, message\)/)
assert.match(source, /AppendJsonlMessage\(teamName, messageNode\)/)
assert.match(source, /MigrateLegacyMessagesToJsonl\(teamName, filePath\)/)
assert.match(source, /File\.Move\(tempPath, jsonlPath\)/)
assert.match(source, /File\.Delete\(legacyPath\)/)
assert.match(source, /ReadRecentJsonlMessages\(jsonlPath, normalizedLimit\)/)
assert.match(source, /A partial or corrupt append must not hide valid earlier messages\./)
assert.doesNotMatch(source, /WriteJsonNode\(messagesFilePath, messages\)/)

console.log('team runtime JSONL verification passed')
