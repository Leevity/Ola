import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const read = (relativePath: string): Promise<string> =>
  readFile(path.join(root, relativePath), 'utf8')

const [
  uiStore,
  chatStore,
  layout,
  navRail,
  workspaceHome,
  settingsPage,
  capabilityCenter,
  workspaceSidebar,
  remotePage,
  themePanel
] = await Promise.all([
  read('src/renderer/src/stores/ui-store.ts'),
  read('src/renderer/src/stores/chat-store.ts'),
  read('src/renderer/src/components/layout/Layout.tsx'),
  read('src/renderer/src/components/layout/NavRail.tsx'),
  read('src/renderer/src/components/chat/WorkspaceHome.tsx'),
  read('src/renderer/src/components/settings/SettingsPage.tsx'),
  read('src/renderer/src/components/settings/CapabilityCenterPanel.tsx'),
  read('src/renderer/src/components/layout/WorkspaceSidebar.tsx'),
  read('src/renderer/src/components/remote/RemotePage.tsx'),
  read('src/renderer/src/components/settings/GlobalThemePanel.tsx')
])

assert(
  uiStore.includes("export type AppMode = 'chat' | 'clarify' | 'execute' | 'acp'") &&
    uiStore.includes("mode === 'cowork' || mode === 'code' || mode === 'execute'"),
  'App mode migration to Execute is incomplete'
)
assert(
  uiStore.includes('remoteDialogOpen') && uiStore.includes('openRemoteDialog'),
  'remote dialog state is missing'
)
assert(
  workspaceSidebar.includes("openRemoteDialog('ssh')") &&
    layout.includes('open={remoteDialogOpen}') &&
    layout.includes('<RemotePage') &&
    layout.includes('onRequestClose={closeRemoteDialog}') &&
    layout.includes('onToggleMaximize') &&
    layout.includes('startRemoteDialogDrag') &&
    remotePage.includes('closeWorkspace') &&
    remotePage.includes('onRequestClose'),
  'remote control does not open as a standalone closable dialog'
)
assert(themePanel.includes('themePreset.remoteHint'), 'remote workspace palette preview is missing')
assert(
  chatStore.includes("export type SessionMode = 'chat' | 'clarify' | 'execute' | 'acp'") &&
    chatStore.includes("mode === 'cowork' || mode === 'code' || mode === 'execute'"),
  'legacy session modes are not normalized to Execute'
)
assert(
  uiStore.includes('export type ActiveSurface =') &&
    uiStore.includes('function activeSurfacePatch(activeSurface: ActiveSurface)') &&
    layout.includes('const activeSurface = useUIStore((s) => s.activeSurface)'),
  'single ActiveSurface navigation state is missing'
)

for (const action of ['new-task', 'search', 'projects', 'tasks', 'capabilities']) {
  assert(navRail.includes(`value: '${action}'`), `primary navigation is missing ${action}`)
}
assert(navRail.includes('aria-current={item.active'), 'primary navigation current state is missing')
assert(
  navRail.includes("openSettingsPage('plugin')"),
  'capability center is not directly reachable'
)

assert(
  workspaceHome.includes('<ProjectWikiPanel') && workspaceHome.includes('<CodeGraphDashboard'),
  'Wiki and CodeGraph are not reachable from the project page'
)
assert(
  settingsPage.includes('function AiModelsPanel()') &&
    settingsPage.includes('role="tablist"') &&
    settingsPage.includes('plugin: CapabilityCenterPanel'),
  'AI model tabs or capability center integration is incomplete'
)
assert(
  capabilityCenter.includes("id: 'custom'") &&
    capabilityCenter.includes("setSettingsTab(tab.id === 'custom' ? 'extension' : 'plugin')") &&
    settingsPage.includes("id: 'mcp'") &&
    settingsPage.includes("id: 'skillsmarket'") &&
    settingsPage.includes("id: 'channel'") &&
    settingsPage.includes("id: 'websearch'"),
  'plugin center or separated integration settings are incomplete'
)

for (const removedPath of [
  'src/renderer/src/components/settings/SettingsDialog.tsx',
  'src/renderer/src/components/chat/ProjectHomePage.tsx'
]) {
  await assert.rejects(access(path.join(root, removedPath)), `${removedPath} should be removed`)
}

console.log('product-experience verification passed')
