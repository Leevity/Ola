import { useSshStore } from '@renderer/stores/ssh-store'
import { useTerminalStore } from '@renderer/stores/terminal-store'

export function getProjectTerminalBaseTitle(
  projectName?: string | null,
  workingFolder?: string | null
): string {
  const trimmedProjectName = projectName?.trim()
  if (trimmedProjectName) return trimmedProjectName

  const folderName = workingFolder?.split(/[\\/]/).filter(Boolean).pop()?.trim()
  return folderName || 'Terminal'
}

interface EnsureProjectTerminalReadyOptions {
  projectId?: string | null
  projectName?: string | null
  workingFolder?: string | null
  sshConnectionId?: string | null
}

export async function ensureProjectTerminalReady({
  projectId,
  projectName,
  workingFolder,
  sshConnectionId
}: EnsureProjectTerminalReadyOptions): Promise<string | null> {
  if (sshConnectionId) {
    const sshStore = useSshStore.getState()
    if (!sshStore._loaded) {
      await sshStore.loadAll()
    }

    const normalizedProjectId = projectId ?? null
    const existingSshTab =
      sshStore.openTabs.find(
        (tab) =>
          tab.type === 'terminal' &&
          tab.connectionId === sshConnectionId &&
          (tab.projectId ?? null) === normalizedProjectId
      ) ?? null

    useTerminalStore.getState().setActiveTab(null)

    if (existingSshTab) {
      useSshStore.getState().setActiveTab(existingSshTab.id)
      return existingSshTab.id
    }

    return await useSshStore.getState().openTerminalTab(sshConnectionId, projectId)
  }

  if (!workingFolder) return null

  const terminalStore = useTerminalStore.getState()
  terminalStore.init()

  const existingLocalTab = terminalStore.findTabByCwd(workingFolder, projectId)
  useSshStore.getState().setActiveTab(null)

  if (existingLocalTab) {
    useTerminalStore.getState().setActiveTab(existingLocalTab.id)
    return existingLocalTab.id
  }

  return await useTerminalStore
    .getState()
    .createTab(
      workingFolder,
      getProjectTerminalBaseTitle(projectName, workingFolder),
      undefined,
      projectId
    )
}
