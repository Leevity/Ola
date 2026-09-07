import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_CODE_PROFILE,
  DEFAULT_WORK_PROFILE,
  inferTaskProfile,
  normalizeTaskProfile,
  profileConfigFor
} from '../src/renderer/src/lib/task-profile.ts'

assert.equal(normalizeTaskProfile('code'), 'code')
assert.equal(normalizeTaskProfile('anything-else'), 'work')
assert.equal(inferTaskProfile('code', undefined, undefined), 'code')
assert.equal(inferTaskProfile('cowork', undefined, undefined), 'code')
assert.equal(inferTaskProfile('execute', 'project-1', undefined), 'code')
assert.equal(inferTaskProfile('execute', undefined, 'C:/repo'), 'code')
assert.equal(inferTaskProfile('chat', undefined, undefined), 'work')

assert.equal(profileConfigFor('work').defaultSessionMode, DEFAULT_WORK_PROFILE.defaultSessionMode)
assert.equal(profileConfigFor('code').defaultSessionMode, DEFAULT_CODE_PROFILE.defaultSessionMode)
assert.equal(profileConfigFor('code', undefined, { allowShell: false }).allowShell, false)
assert.equal(profileConfigFor('work', { autoIndex: true }).autoIndex, true)

const root = process.cwd()
const read = (relativePath: string): Promise<string> =>
  readFile(path.join(root, relativePath), 'utf8')

const [chatStore, chatHome, onboarding, settingsPanel, workspaceSidebar, layout] =
  await Promise.all([
    read('src/renderer/src/stores/chat-store.ts'),
    read('src/renderer/src/components/chat/ChatHomePage.tsx'),
    read('src/renderer/src/components/onboarding/OnboardingPage.tsx'),
    read('src/renderer/src/components/settings/WorkModesPanel.tsx'),
    read('src/renderer/src/components/layout/WorkspaceSidebar.tsx'),
    read('src/renderer/src/components/layout/Layout.tsx')
  ])

const zhLayout = JSON.parse(
  (await read('src/renderer/src/locales/zh/layout.json')).replace(/^\uFEFF/, '')
) as {
  resourcesPage?: {
    items?: { agents?: Record<string, { name?: string; description?: string }> }
    templates?: { items?: Record<string, { description?: string }> }
  }
}
const localizedAgents = zhLayout.resourcesPage?.items?.agents ?? {}
for (const agentName of ['debugger', 'researcher', 'project-intelligence-analyst']) {
  assert(localizedAgents[agentName]?.name, `Chinese Agent name is missing for ${agentName}`)
  assert(
    localizedAgents[agentName]?.description,
    `Chinese Agent description is missing for ${agentName}`
  )
}
for (const templateName of ['AGENTS.md', 'SOUL.md', 'USER.md', 'MEMORY.md']) {
  assert(
    zhLayout.resourcesPage?.templates?.items?.[templateName]?.description,
    `Chinese workspace template description is missing for ${templateName}`
  )
}
const resourcesPage = await read('src/renderer/src/components/resources/ResourcesPage.tsx')
assert(resourcesPage.includes('resourcesPage.items.${item.kind}.${item.name}.name'))
assert(resourcesPage.includes('resourcesPage.templates.title'))

assert(chatStore.includes('taskProfileLocked'), 'session profile lock is missing')
assert(chatStore.includes('lockSessionTaskProfile'), 'first-message profile lock hook is missing')
assert(
  !chatHome.includes('taskProfile.work.label'),
  'duplicate home profile selector should be removed'
)
assert(layout.includes('<WorkspaceSidebar />'), 'active layout sidebar is missing')
assert(
  workspaceSidebar.includes('sidebar.taskProfileSwitcher'),
  'sidebar profile switcher is missing'
)
assert(workspaceSidebar.includes('sidebar.newChat'), 'sidebar new conversation entry is missing')
assert(
  workspaceSidebar.includes("key: 'remote'"),
  'remote control entry is missing from the active sidebar'
)
assert(
  workspaceSidebar.includes("openRemotePage('ssh')"),
  'remote control entry does not open the remote page'
)
assert(
  workspaceSidebar.indexOf('sidebar.taskProfileSwitcher') <
    workspaceSidebar.indexOf('{navItems.slice(0, 3).map(renderNavItem)}'),
  'sidebar profile switcher must appear before new conversation'
)
assert(onboarding.includes("'profile'"), 'onboarding profile step is missing')
assert(
  settingsPanel.includes('workModes.shared.securityTitle'),
  'shared security settings are missing'
)
assert(settingsPanel.includes('workModes.shellType'), 'Code shell strategy settings are missing')
assert(settingsPanel.includes('workModes.gitPolicy'), 'Code Git strategy settings are missing')
assert(
  settingsPanel.includes('workModes.verificationPolicy'),
  'Code verification settings are missing'
)
assert(settingsPanel.includes('workModes.fileApproval'), 'Code approval settings are missing')

for (const legacyPath of [
  'src/renderer/src/components/settings/SettingsDialog.tsx',
  'src/renderer/src/components/chat/ProjectHomePage.tsx'
]) {
  await assert.rejects(access(path.join(root, legacyPath)), `${legacyPath} should remain removed`)
}

console.log('task-profile verification passed')
