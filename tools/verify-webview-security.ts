import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const main = await readFile('src/main/index.ts', 'utf8')
const browserPanel = await readFile('src/renderer/src/components/layout/BrowserPanel.tsx', 'utf8')

assert.match(main, /window\.webContents\.on\('will-attach-webview'/)
assert.match(main, /const isHttpUrl = \/\^https\?:\\\/\\\//)
assert.match(main, /params\.partition === 'persist:ola-browser'/)
assert.match(main, /event\.preventDefault\(\)/)
assert.match(main, /delete webPreferences\.preload/)
assert.match(main, /delete webPreferences\.additionalArguments/)
assert.match(main, /webPreferences\.nodeIntegration = false/)
assert.match(main, /webPreferences\.contextIsolation = true/)
assert.match(main, /webPreferences\.sandbox = true/)
assert.match(main, /webPreferences\.webSecurity = true/)
assert.match(main, /webPreferences\.allowRunningInsecureContent = false/)
assert.match(main, /getBuiltInBrowserStorageSessions/)
assert.match(main, /browserSession\.setPermissionCheckHandler\(\(\) => false\)/)
assert.match(main, /browserSession\.setPermissionRequestHandler\(/)
assert.match(main, /callback\(false\)/)
assert.match(main, /window\.webContents\.setWindowOpenHandler/)
assert.match(main, /return \{ action: 'deny' \}/)
assert.match(main, /webviewTag: false/)
assert.match(browserPanel, /<webview/)
assert.match(browserPanel, /partition: BUILTIN_BROWSER_PARTITION/)
assert.match(browserPanel, /canNavigateTo\(normalized\)/)

console.log('webview security verification passed')
