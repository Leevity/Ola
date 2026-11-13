import { readCollapsedSource } from './lib/source-text.ts'

// The assertions below are about tokens, not layout: the source is read with whitespace
// collapsed so a Biome re-wrap cannot turn this gate red.
const source = await readCollapsedSource('src/main/ipc/browser-handlers.ts')
const authorizeWorkspace = /await\s+isAuthorizedBrowserWorkspace\(\s*input\s*\.\s*workspaceId\s*\)/
// Each handler is bounded by the next registration, never by a character count. A fixed
// window on collapsed text reaches into the neighbouring handler and would accept that
// handler's authorization call as proof for this one — measured at 658 collapsed chars
// between two adjacent cookie handlers, well inside the old 1800-char window.
const registrations = [...source.matchAll(/register(?:TrustedBrowser)?MessagePackHandler/g)].map(
  (match) => match.index as number
)
for (const channel of [
  "'browser:export-cookies'",
  "'browser:import-cookies'",
  "'browser:clear-cookies'"
]) {
  const start = source.indexOf(channel)
  if (start < 0) throw new Error(`Missing ${channel} handler`)
  const owner = registrations.filter((index) => index <= start).at(-1)
  if (owner === undefined) throw new Error(`${channel} is not inside a MessagePack registration`)
  const next = registrations.find((index) => index > start)
  const handler = source.slice(owner, next ?? source.length)
  if (!authorizeWorkspace.test(handler)) {
    throw new Error(`${channel} must authorize the target workspace in Main`)
  }
}
if (!/if\s*\(\s*workspaceId\s*===\s*'local-personal'\s*\)\s*return\s+true/.test(source)) {
  throw new Error('Local personal workspace must remain available offline')
}
if (!/await\s+loadManagedWorkspaceIds\(\s*\)/.test(source)) {
  throw new Error('Managed browser workspace operations must validate current account membership')
}
console.log('browser workspace authorization verification passed')
