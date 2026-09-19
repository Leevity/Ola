import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  createRemoteWorkspaceStyle,
  getSshChromePalette
} from '../src/renderer/src/lib/theme-presets.ts'

const root = process.cwd()
const read = async (file: string): Promise<string> => readFile(path.join(root, file), 'utf8')

const palette = getSshChromePalette('graphite', 'light')
const style = createRemoteWorkspaceStyle(palette) as Record<string, string>
assert.equal(style.background, palette.terminalFrame)
assert.equal(style.color, palette.terminalText)
assert.equal(style['--remote-canvas'], palette.terminalFrame)
assert.equal(style['--foreground'], palette.terminalText)
assert.equal(style['--remote-panel'], palette.panelStrong)

const [remotePage, sshPage, noVnc, ironRdp, enLayout, zhLayout] = await Promise.all([
  read('src/renderer/src/components/remote/RemotePage.tsx'),
  read('src/renderer/src/components/ssh/SshPage.tsx'),
  read('src/renderer/src/components/remote/NoVncViewer.tsx'),
  read('src/renderer/src/components/remote/IronRdpViewer.tsx'),
  read('src/renderer/src/locales/en/layout.json'),
  read('src/renderer/src/locales/zh/layout.json')
])
assert.ok(remotePage.includes('style={remoteWorkspaceStyle}'))
assert.ok(
  sshPage.includes("embedded || shellTone !== 'library' ? sshTerminalThemePreset : themePreset"),
  'embedded SSH must use the remote workspace palette'
)
assert.ok(
  sshPage.includes("const activeChromeMode = embedded ? 'dark' : resolvedThemeMode"),
  'embedded SSH must keep the remote workbench in its dark terminal mode'
)
assert.ok(noVnc.includes('bg-[color:var(--remote-surface)]'))
assert.ok(ironRdp.includes('bg-[color:var(--remote-surface)]'))
assert.ok(!noVnc.includes('defaultValue'))
assert.ok(!ironRdp.includes('defaultValue'))
assert.ok(!remotePage.match(/[\p{Script=Han}]/u), 'remote UI copy must come from translations')
assert.ok(
  !remotePage.includes('defaultValue'),
  'remote UI must not add inline translation fallbacks'
)

const requiredRemoteKeys = [
  'connectionStatus',
  'screenSharingStatus',
  'screenSharingEnabled',
  'screenSharingRequesting',
  'screenSharingDisabled',
  'stopScreenSharing',
  'startScreenSharing',
  'sameAccountDevices',
  'online',
  'offline',
  'connecting',
  'connectWithoutPassword',
  'disconnectSession',
  'serviceEndpoint',
  'cancel'
]
for (const [locale, source] of [
  ['en', enLayout],
  ['zh', zhLayout]
] as const) {
  const translations = JSON.parse(source.replace(/^\uFEFF/, '')) as {
    remote?: Record<string, unknown>
  }
  for (const key of requiredRemoteKeys) {
    assert.equal(typeof translations.remote?.[key], 'string', `${locale} is missing remote.${key}`)
  }
}
console.log('remote workspace theme verification passed')
