import { readFile } from 'node:fs/promises'

const source = await readFile(
  new URL('../src/main/ipc/browser-handlers.ts', import.meta.url),
  'utf8'
)
for (const channel of [
  "'browser:export-cookies'",
  "'browser:import-cookies'",
  "'browser:clear-cookies'"
]) {
  const start = source.indexOf(channel)
  if (start < 0) throw new Error(`Missing ${channel} handler`)
  const handler = source.slice(start, start + 1800)
  if (!handler.includes('await isAuthorizedBrowserWorkspace(input.workspaceId)')) {
    throw new Error(`${channel} must authorize the target workspace in Main`)
  }
}
if (!source.includes("if (workspaceId === 'local-personal') return true")) {
  throw new Error('Local personal workspace must remain available offline')
}
if (!source.includes('await loadManagedWorkspaceIds()')) {
  throw new Error('Managed browser workspace operations must validate current account membership')
}
console.log('browser workspace authorization verification passed')
