import assert from 'node:assert/strict'
import { readCollapsedSource } from './lib/source-text.ts'

// These are security invariants about tokens, not layout. The sources are read with
// whitespace collapsed so a re-wrap cannot turn the gate red; patterns tolerate a space
// wherever the formatter may break a line. Nothing here is line-anchored — the `\^` in
// the isHttpUrl pattern is a literal caret inside the source's own regex, not an anchor.
const main = await readCollapsedSource('src/main/index.ts')
const rendererSecurity = await readCollapsedSource('src/main/renderer-security.ts')
const browserPanel = await readCollapsedSource(
  'src/renderer/src/components/layout/BrowserPanel.tsx'
)

assert.match(main, /window\.webContents\.on\(\s*'will-attach-webview'/)
assert.match(main, /const isHttpUrl\s*=\s*\/\^https\?:\\\/\\\//)
assert.match(main, /getRegisteredWindowWorkspace\(\s*window\s*\)/)
assert.match(main, /browserPartitionForWorkspace\(\s*workspaceId\s*\)/)
assert.match(
  main,
  /shouldUseDefaultBrowserSession\(\s*workspaceId\s*\?\?\s*undefined\s*\)\s*\?\s*!params\.partition/
)
assert.match(main, /params\.partition\s*===\s*expectedPartition/)
assert.match(main, /browserSession\.setPermissionCheckHandler\(\s*\(\)\s*=>\s*false\s*\)/)
// Bind preventDefault to the webview attachment guard: a bare token check is satisfied
// by three unrelated preventDefault calls elsewhere in this bootstrap file.
assert.match(
  main,
  /if\s*\(\s*!isHttpUrl\s*\|\|\s*!isAllowedPartition\s*\)\s*\{\s*event\s*\.\s*preventDefault\(\)/,
  'webview attachment guard must preventDefault on an unsafe url or partition'
)
assert.match(main, /delete\s+webPreferences\.preload/)
assert.match(main, /delete\s+webPreferences\.additionalArguments/)
assert.match(main, /webPreferences\.nodeIntegration\s*=\s*false/)
assert.match(main, /webPreferences\.contextIsolation\s*=\s*true/)
assert.match(main, /webPreferences\.sandbox\s*=\s*true/)
assert.match(main, /webPreferences\.webSecurity\s*=\s*true/)
assert.match(main, /webPreferences\.allowRunningInsecureContent\s*=\s*false/)
assert.match(main, /getBuiltInBrowserStorageSessions/)
assert.match(main, /browserSession\.setPermissionCheckHandler\(\s*\(\)\s*=>\s*false\s*\)/)
assert.match(main, /browserSession\.setPermissionRequestHandler\(/)
assert.match(main, /callback\(\s*false\s*\)/)
assert.match(main, /registerTrustedRendererUrl\(\s*window,\s*rendererUrl\s*\)/)
assert.match(rendererSecurity, /window\.webContents\.setWindowOpenHandler/)
assert.match(rendererSecurity, /return\s+\{\s*action:\s*'deny'\s*\}/)
assert.match(main, /webviewTag:\s*false/)
assert.match(browserPanel, /<webview/)
assert.match(browserPanel, /partition:\s*browserPartitionForWorkspace\(\s*workspaceId\s*\)/)
assert.match(browserPanel, /canNavigateTo\(\s*normalized\s*\)/)

console.log('webview security verification passed')
