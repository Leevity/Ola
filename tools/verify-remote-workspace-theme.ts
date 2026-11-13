import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  createRemoteWorkspaceStyle,
  getSshChromePalette
} from '../src/renderer/src/lib/theme-presets.ts'
import { readCollapsedSource } from './lib/source-text.ts'

const root = process.cwd()
// Locale catalogs are parsed as JSON rather than pattern-matched, so they stay raw:
// JSON parsing is already whitespace-agnostic, and collapsing could alter string
// values. The TSX sources are collapsed because every assertion on them is about
// tokens, not layout.
const read = async (file: string): Promise<string> => readFile(path.join(root, file), 'utf8')

const palette = getSshChromePalette('graphite', 'light')
const style = createRemoteWorkspaceStyle(palette) as Record<string, string>
assert.equal(style.background, palette.terminalFrame)
assert.equal(style.color, palette.terminalText)
assert.equal(style['--remote-canvas'], palette.terminalFrame)
assert.equal(style['--foreground'], palette.terminalText)
assert.equal(style['--remote-panel'], palette.panelStrong)

const [remotePage, sshPage, noVnc, ironRdp, taskInbox] = await Promise.all([
  readCollapsedSource('src/renderer/src/components/remote/RemotePage.tsx'),
  readCollapsedSource('src/renderer/src/components/ssh/SshPage.tsx'),
  readCollapsedSource('src/renderer/src/components/remote/NoVncViewer.tsx'),
  readCollapsedSource('src/renderer/src/components/remote/IronRdpViewer.tsx'),
  readCollapsedSource('src/renderer/src/components/remote/RemoteMeshTaskInbox.tsx')
])
const LOCALES = [
  'ar',
  'de',
  'en',
  'es',
  'fr',
  'id',
  'it',
  'ja',
  'ko',
  'nl',
  'pt',
  'ru',
  'th',
  'tr',
  'vi',
  'zh'
] as const
const layouts = await Promise.all(
  LOCALES.map((locale) => read(`src/renderer/src/locales/${locale}/layout.json`))
)
assert.match(remotePage, /style=\{\s*remoteWorkspaceStyle\s*\}/)
assert.match(
  sshPage,
  /embedded\s*\|\|\s*shellTone\s*!==\s*'library'\s*\?\s*sshTerminalThemePreset\s*:\s*themePreset/,
  'embedded SSH must use the remote workspace palette'
)
assert.match(
  sshPage,
  /const activeChromeMode =\s*embedded\s*\?\s*'dark'\s*:\s*resolvedThemeMode/,
  'embedded SSH must keep the remote workbench in its dark terminal mode'
)
// These are Tailwind class-name string literals: their contents are invariant under
// formatting, so a plain substring check is already layout-independent.
assert.ok(noVnc.includes('bg-[color:var(--remote-surface)]'))
assert.ok(ironRdp.includes('bg-[color:var(--remote-surface)]'))
assert.ok(!noVnc.includes('defaultValue'))
assert.ok(!ironRdp.includes('defaultValue'))
assert.ok(!remotePage.match(/[\p{Script=Han}]/u), 'remote UI copy must come from translations')
assert.ok(
  !remotePage.includes('defaultValue'),
  'remote UI must not add inline translation fallbacks'
)
assert.ok(!taskInbox.match(/[\p{Script=Han}]/u), 'remote UI copy must come from translations')
assert.ok(
  !taskInbox.includes('defaultValue'),
  'remote UI must not add inline translation fallbacks'
)

// This older remote copy was only ever translated into en/zh; the other 14 catalogs
// still lack every one of these keys. That gap predates controller input and mesh
// task dispatch, so it stays scoped to en/zh instead of widening into 210 strings.
const legacyRemoteKeys = [
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
// Copy added for controller input and mesh task dispatch must reach every locale:
// a controller who cannot read the hint, or a peer who cannot read the refusal,
// has no way to act on it.
const requiredRemoteKeys = [
  'controlInputHint',
  'meshTaskTitle',
  'meshTaskFrom',
  'meshTaskAccept',
  'meshTaskReject',
  'meshTaskRunning',
  'meshTaskAttendedNote'
]
// A refusal the peer sent is only actionable if the local user can read why, so
// every reason main can return needs copy in every locale.
const requiredMeshTaskReasons = [
  'unknown-task',
  'already-decided',
  'user-rejected',
  'access-disabled',
  'session-busy',
  'confirmation-required',
  'quota-exhausted'
]
for (const [index, locale] of LOCALES.entries()) {
  const translations = JSON.parse(layouts[index].replace(/^\uFEFF/, '')) as {
    remote?: Record<string, unknown>
  }
  for (const key of requiredRemoteKeys) {
    assert.equal(typeof translations.remote?.[key], 'string', `${locale} is missing remote.${key}`)
  }
  const reasons = translations.remote?.meshTaskReason as Record<string, unknown> | undefined
  for (const reason of requiredMeshTaskReasons) {
    assert.equal(
      typeof reasons?.[reason],
      'string',
      `${locale} is missing remote.meshTaskReason.${reason}`
    )
  }
  if (locale !== 'en' && locale !== 'zh') continue
  for (const key of legacyRemoteKeys) {
    assert.equal(typeof translations.remote?.[key], 'string', `${locale} is missing remote.${key}`)
  }
}
console.log('remote workspace theme verification passed')
