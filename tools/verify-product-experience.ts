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
  settingsResolver,
  settingsRegistry,
  workspaceSidebar,
  remotePage,
  app,
  mainIndex,
  themePanel,
  sessionTabStrip,
  migrationPanel,
  teamCreateTool,
  teamMessageTool,
  teamStatusTool,
  teamDeleteTool,
  teamPrompts,
  goalTool,
  taskTool,
  planTool,
  webSearchTool,
  memoryTool,
  cronTool,
  bashTool,
  searchTool,
  fsTool,
  skillTool,
  browserTool,
  codeCompatibleTool,
  askUserTool,
  widgetTool,
  webContentsViewService
] = await Promise.all([
  read('src/renderer/src/stores/ui-store.ts'),
  read('src/renderer/src/stores/chat-store.ts'),
  read('src/renderer/src/components/layout/Layout.tsx'),
  read('src/renderer/src/components/layout/NavRail.tsx'),
  read('src/renderer/src/components/chat/WorkspaceHome.tsx'),
  read('src/renderer/src/components/settings/SettingsPage.tsx'),
  read('src/renderer/src/components/settings/CapabilityCenterPanel.tsx'),
  read('src/renderer/src/components/settings/settings-panel-resolver.tsx'),
  read('src/renderer/src/components/settings/settings-registry.ts'),
  read('src/renderer/src/components/layout/WorkspaceSidebar.tsx'),
  read('src/renderer/src/components/remote/RemotePage.tsx'),
  read('src/renderer/src/App.tsx'),
  read('src/main/index.ts'),
  read('src/renderer/src/components/settings/GlobalThemePanel.tsx'),
  read('src/renderer/src/components/layout/SessionTabStrip.tsx'),
  read('src/renderer/src/components/settings/MigrationPanel.tsx'),
  read('src/renderer/src/lib/agent/teams/tools/team-create.ts'),
  read('src/renderer/src/lib/agent/teams/tools/send-message.ts'),
  read('src/renderer/src/lib/agent/teams/tools/team-status.ts'),
  read('src/renderer/src/lib/agent/teams/tools/team-delete.ts'),
  read('src/renderer/src/lib/agent/teams/prompts.ts'),
  read('src/renderer/src/lib/tools/goal-tool.ts'),
  read('src/renderer/src/lib/tools/todo-tool.ts'),
  read('src/renderer/src/lib/tools/plan-tool.ts'),
  read('src/renderer/src/lib/tools/web-search-tool.ts'),
  read('src/renderer/src/lib/tools/memory-tool.ts'),
  read('src/renderer/src/lib/tools/cron-tool.ts'),
  read('src/renderer/src/lib/tools/bash-tool.ts'),
  read('src/renderer/src/lib/tools/search-tool.ts'),
  read('src/renderer/src/lib/tools/fs-tool.ts'),
  read('src/renderer/src/lib/tools/skill-tool.ts'),
  read('src/renderer/src/lib/tools/browser-tool.ts'),
  read('src/renderer/src/lib/tools/code-compatible-tool.ts'),
  read('src/renderer/src/lib/tools/ask-user-tool.ts'),
  read('src/renderer/src/lib/tools/widget-tool.ts'),
  read('src/main/browser/web-contents-view-service.ts')
])

assert(
  uiStore.includes("export type AppMode = 'chat' | 'clarify' | 'execute' | 'acp'") &&
    uiStore.includes("mode === 'cowork' || mode === 'code' || mode === 'execute'"),
  'App mode migration to Execute is incomplete'
)
assert(
  workspaceSidebar.includes('IPC.SSH_WINDOW_OPEN') &&
    !workspaceSidebar.includes('openRemoteDialog') &&
    (workspaceSidebar.match(/navRail\.remote/g) ?? []).length === 1 &&
    !layout.includes('<RemotePage') &&
    !layout.includes('remoteDialogOpen') &&
    app.includes('<RemotePage standalone />') &&
    mainIndex.includes("registerMessagePackHandler<void>('ssh-window:open'") &&
    mainIndex.includes('showSshWindow()') &&
    remotePage.includes("ipcClient.invoke('window:close')"),
  'remote control must use the dedicated native window without an embedded duplicate'
)
assert(
  mainIndex.includes("registerMessagePackHandler<string>('session-window:open'") &&
    mainIndex.includes("registerMessagePackHandler<string>('session-window:focus-if-open'") &&
    (mainIndex.match(/UNTRUSTED_IPC_SENDER/g) ?? []).length >= 2,
  'detached session window IPC must reject untrusted frames'
)
assert(themePanel.includes('themePreset.remoteHint'), 'remote workspace palette preview is missing')
assert(
  sessionTabStrip.includes('draggable') &&
    sessionTabStrip.includes('text/session-tab') &&
    sessionTabStrip.includes('event.altKey') &&
    sessionTabStrip.includes('openSessionOrFocusDetached') &&
    sessionTabStrip.includes('workspaceLayoutStorageKey'),
  'workspace session tabs must support isolated drag and keyboard reordering'
)
assert(
  migrationPanel.includes('handoverReady') &&
    migrationPanel.includes('handoverBlocker') &&
    migrationPanel.includes('describeBusinessHandoverBlocker') &&
    migrationPanel.includes('SCHEMA_UNSUPPORTED') &&
    migrationPanel.includes('BACKUP_SPACE') &&
    migrationPanel.includes('BACKUP_DIRECTORY') &&
    migrationPanel.includes('DATABASE_UNAVAILABLE') &&
    migrationPanel.includes('businessHandoverPreflight') &&
    migrationPanel.includes('businessHandoverBackupSpace') &&
    migrationPanel.includes('businessHandoverSourceUnavailable'),
  'business handover preflight status is not visible in migration settings'
)
assert(
  teamCreateTool.includes('createTeamRuntime') &&
    teamMessageTool.includes('appendTeamRuntimeMessage') &&
    teamStatusTool.includes('getTeamRuntimeSnapshot') &&
    teamDeleteTool.includes('deleteTeamRuntime') &&
    !teamCreateTool.includes('nativeOnlyTeamResult') &&
    !teamMessageTool.includes('nativeOnlyTeamResult') &&
    !teamStatusTool.includes('nativeOnlyTeamResult') &&
    !teamDeleteTool.includes('nativeOnlyTeamResult') &&
    teamPrompts.includes('TS in-process team runtime') &&
    !teamPrompts.includes('.NET Native Worker'),
  'team tools must use the TS team runtime instead of Native-only placeholders'
)
assert(
  goalTool.includes('useGoalStore') &&
    goalTool.includes('loadGoalForSession') &&
    goalTool.includes('createGoal') &&
    goalTool.includes('updateGoal') &&
    !goalTool.includes('encodeNativeOnlyGoalResult') &&
    !goalTool.includes('.NET Native Worker'),
  'goal tools must use the workspace-scoped TS goal store instead of Native-only placeholders'
)
assert(
  taskTool.includes('useTaskStore') &&
    taskTool.includes('addTask') &&
    taskTool.includes('updateTask') &&
    taskTool.includes('getTasksBySession') &&
    !taskTool.includes('encodeNativeOnlyTaskResult') &&
    !taskTool.includes('.NET Native Worker'),
  'task tools must use the workspace-scoped TS task store instead of Native-only placeholders'
)
assert(
  planTool.includes('usePlanStore') &&
    planTool.includes('enterPlanMode') &&
    planTool.includes('exitPlanMode') &&
    planTool.includes('awaiting_review') &&
    !planTool.includes('nativeOnlyPlanResult') &&
    !planTool.includes('.NET Native Worker'),
  'plan mode tools must use the TS plan store instead of Native-only placeholders'
)
assert(
  webSearchTool.includes('IPC.WEB_SEARCH') &&
    webSearchTool.includes('IPC.WEB_FETCH') &&
    webSearchTool.includes('useSettingsStore') &&
    !webSearchTool.includes('nativeOnlyResult'),
  'web search tools must use Main-owned TS services instead of Native-only placeholders'
)
assert(
  memoryTool.includes('loadLayeredMemorySnapshot') &&
    memoryTool.includes('MemoryList') &&
    memoryTool.includes('MemoryRead') &&
    memoryTool.includes('MemorySearch') &&
    !memoryTool.includes('encodeNativeOnlyMemoryResult') &&
    !memoryTool.includes('.NET Native Worker'),
  'memory tools must use the workspace-scoped TS memory files instead of Native-only placeholders'
)
assert(
  cronTool.includes('IPC.CRON_ADD') &&
    cronTool.includes('IPC.CRON_UPDATE') &&
    cronTool.includes('IPC.CRON_REMOVE') &&
    cronTool.includes('IPC.CRON_LIST') &&
    !cronTool.includes('nativeOnlyCronResult') &&
    !cronTool.includes('.NET Native Worker'),
  'cron tools must use workspace-scoped TS IPC instead of Native-only placeholders'
)
assert(
  bashTool.includes('IPC.SHELL_EXEC') &&
    bashTool.includes('ctx.workingFolder') &&
    !bashTool.includes('nativeOnlyBashResult') &&
    !bashTool.includes('.NET Native Worker'),
  'Bash must use the Main TS shell executor instead of a Native-only placeholder'
)
assert(
  searchTool.includes('IPC.FS_GLOB') &&
    searchTool.includes('IPC.FS_GREP') &&
    !searchTool.includes('nativeOnlyResult') &&
    !searchTool.includes('.NET Native Worker'),
  'Glob and Grep must use Main TS search services instead of Native-only placeholders'
)
assert(
  fsTool.includes('IPC.FS_READ_FILE') &&
    fsTool.includes('IPC.FS_LIST_DIR') &&
    fsTool.includes('IPC.FS_WRITE_FILE') &&
    fsTool.includes('beforeContent') &&
    fsTool.includes('old_string was not found') &&
    fsTool.includes('JSON.parse(before)') &&
    fsTool.includes('NotebookEdit') &&
    fsTool.includes('resolveWorkspacePath') &&
    !fsTool.includes('nativeOnlyResult'),
  'Read and LS must use the workspace-scoped Main TS filesystem service'
)
assert(
  skillTool.includes("ipcClient.invoke('skills:load'") &&
    skillTool.includes('record.content') &&
    !skillTool.includes('.NET Native Worker'),
  'Skill must load content through the Main TS skill catalog'
)
assert(
  browserTool.includes('handleNativeBrowserToolRequest') &&
    browserTool.includes("executeBrowserTool('BrowserNavigate'") &&
    !browserTool.includes('nativeOnlyBrowserResult') &&
    !browserTool.includes('.NET Native Worker'),
  'Browser tools must use the TS browser UI/IPC execution path instead of Native-only placeholders'
)
assert(
  codeCompatibleTool.includes('IPC.SHELL_EXEC') &&
    codeCompatibleTool.includes("'powershell.exe'") &&
    !codeCompatibleTool.includes('encodeNativeOnlyCodeCompatibleResult') &&
    !codeCompatibleTool.includes('.NET Native Worker'),
  'PowerShell must use the Main TS shell executor instead of a Native-only placeholder'
)
assert(
  askUserTool.includes('handleNativeAskUserRequest({') &&
    askUserTool.includes('ctx.currentToolUseId') &&
    !askUserTool.includes('nativeOnlyAskUserResult') &&
    !askUserTool.includes('.NET Native Worker'),
  'AskUserQuestion must use the renderer interaction bridge instead of a Native-only placeholder'
)
assert(
  widgetTool.includes('encodeStructuredToolResult') &&
    widgetTool.includes('widget_code_chars') &&
    widgetTool.includes('500_000') &&
    !widgetTool.includes('.NET Native Worker'),
  'visualize_show_widget must validate and return a TS-renderable widget result'
)
assert(
  webContentsViewService.includes('class WebContentsViewBrowserService') &&
    webContentsViewService.includes('window.contentView.addChildView') &&
    webContentsViewService.includes('contextIsolation: true') &&
    webContentsViewService.includes('BROWSER_URL_INVALID'),
  'WebContentsView browser lifecycle must have a Main-owned secure service'
)
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
    settingsResolver.includes('plugin: CapabilityCenterPanel'),
  'AI model tabs or capability center integration is incomplete'
)
assert(
  capabilityCenter.includes("id: 'custom'") &&
    capabilityCenter.includes("setSettingsTab(tab.id === 'custom' ? 'extension' : 'plugin')") &&
    settingsRegistry.includes("id: 'mcp'") &&
    settingsRegistry.includes("id: 'skillsmarket'") &&
    settingsRegistry.includes("id: 'channel'") &&
    settingsRegistry.includes("id: 'websearch'"),
  'plugin center or separated integration settings are incomplete'
)

for (const removedPath of [
  'src/renderer/src/components/settings/SettingsDialog.tsx',
  'src/renderer/src/components/chat/ProjectHomePage.tsx'
]) {
  await assert.rejects(access(path.join(root, removedPath)), `${removedPath} should be removed`)
}

console.log('product-experience verification passed')
