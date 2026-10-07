import { useChatStore } from '@renderer/stores/chat-store'
import { useExtensionStore } from '@renderer/stores/extension-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { registerWorkbenchAction } from '@renderer/lib/workbench'
import i18n from '@renderer/locales'

let unregisterActions: Array<() => void> = []
let refreshPromise: Promise<void> | null = null

export async function refreshExtensionWorkbenchContributions(): Promise<void> {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    await useExtensionStore.getState().loadExtensions()
    unregisterActions.forEach((unregister) => unregister())
    unregisterActions = []

    const store = useExtensionStore.getState()
    const projectId = useChatStore.getState().activeProjectId ?? null
    const activeIds = new Set(store.getActiveExtensionIds(projectId))
    const openedView = useUIStore.getState().extensionWorkbenchView
    const openedExtension = store.extensions.find(
      (extension) => extension.id === openedView?.extensionId
    )
    const openedViewStillAvailable = Boolean(
      openedView &&
      openedExtension?.enabled &&
      activeIds.has(openedView.extensionId) &&
      openedExtension.manifest.views?.some((view) => view.name === openedView.view.name)
    )
    if (openedView && !openedViewStillAvailable) {
      useUIStore.getState().closeExtensionWorkbenchView()
    }

    for (const extension of store.extensions) {
      if (!extension.enabled || !activeIds.has(extension.id)) continue
      for (const command of extension.manifest.commands ?? []) {
        const view = extension.manifest.views?.find((candidate) => candidate.name === command.view)
        if (!view) continue
        try {
          unregisterActions.push(
            registerWorkbenchAction({
              id: `extension.${extension.id}.${command.name}`,
              title: command.title,
              group: i18n.t('layout:commandPalette.extensions', { defaultValue: 'Extensions' }),
              keywords: [extension.manifest.name, ...(command.keywords ?? [])],
              run: () => {
                const currentExtension = useExtensionStore
                  .getState()
                  .extensions.find((candidate) => candidate.id === extension.id)
                const currentProjectId = useChatStore.getState().activeProjectId ?? null
                if (
                  !currentExtension?.enabled ||
                  !useExtensionStore
                    .getState()
                    .getActiveExtensionIds(currentProjectId)
                    .includes(extension.id) ||
                  !currentExtension.manifest.views?.some(
                    (candidate) => candidate.name === view.name
                  )
                )
                  return
                useUIStore
                  .getState()
                  .openExtensionWorkbenchView(
                    currentExtension.id,
                    currentExtension.manifest.name,
                    view
                  )
              }
            })
          )
        } catch (error) {
          console.warn('[Extensions] Skipping duplicate workbench command:', command.name, error)
        }
      }
    }
  })().finally(() => {
    refreshPromise = null
  })
  return refreshPromise
}
