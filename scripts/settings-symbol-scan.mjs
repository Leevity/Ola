import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const uiStore = await readFile(path.join(root, 'src/renderer/src/stores/ui-store.ts'), 'utf8')
const settingsPage = await readFile(
  path.join(root, 'src/renderer/src/components/settings/SettingsPage.tsx'),
  'utf8'
)
const union = uiStore.match(/export type SettingsTab =([\s\S]*?)\n\nexport type/)
const ids = [...(union?.[1]?.matchAll(/'([^']+)'/g) ?? [])].map((match) => match[1])
const panelMap = settingsPage.match(/const panelMap:[\s\S]*?\n}\n/)?.[0] ?? ''
const missingPanels = ids.filter((id) => !panelMap.includes(`\n  ${id}:`))
const menuIds = [...settingsPage.matchAll(/\bid:\s*'([^']+)'/g)].map((match) => match[1])
const hiddenTabs = new Set(['hooks', 'aiCoding', 'channel'])
const missingRoutes = ids.filter((id) => !menuIds.includes(id) && !hiddenTabs.has(id))

console.log(
  JSON.stringify(
    { ids, menuIds, hiddenTabs: [...hiddenTabs], missingPanels, missingRoutes },
    null,
    2
  )
)
if (missingPanels.length > 0 || missingRoutes.length > 0) process.exitCode = 1
