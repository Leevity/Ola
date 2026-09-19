import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ProjectWikiGenerateRequest } from '../../shared/project-wiki'
import {
  generateProjectWiki,
  loadProjectWiki,
  validateProjectRoot,
  writeProjectWikiMarkdown,
  type SharedIndexedFile
} from '../wiki/wiki-service'
import { loadWikiDocument, saveWikiDocument } from '../db/capability-dao'
import { getCodeGraphWorker } from '../lib/codegraph-worker'
import { getRegisteredWindowWorkspace } from '../window-ipc'
import { authorizeChannelSessionWorkspace } from '../channels/channel-session-workspace'
import { loadOfflineWorkspaceIds } from '../remote/account-client'

async function getSharedIndexedFiles(
  projectRoot: string
): Promise<SharedIndexedFile[] | undefined> {
  try {
    const worker = getCodeGraphWorker()
    const status = await worker.request<{
      indexed?: boolean
      fileCount?: number
    }>('codegraph/index-status', { workingFolder: projectRoot }, 10_000)
    if (!status?.indexed || !status.fileCount) return undefined
    const result = await worker.request<{
      success?: boolean
      files?: SharedIndexedFile[]
    }>('codegraph/files-tree', { workingFolder: projectRoot }, 10_000)
    if (!result?.success || !Array.isArray(result.files)) return undefined
    return result.files
  } catch {
    // Wiki remains usable if the optional index worker is unavailable.
    return undefined
  }
}

function isTrustedWikiIpcSender(event: IpcMainInvokeEvent): boolean {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  return (
    ownerWindow !== null &&
    !ownerWindow.isDestroyed() &&
    ownerWindow.webContents === event.sender &&
    event.senderFrame === event.sender.mainFrame
  )
}

async function authorizeWikiWorkspace(
  event: IpcMainInvokeEvent,
  requestedWorkspaceId: unknown
): Promise<string> {
  if (!isTrustedWikiIpcSender(event)) throw new Error('Unauthorized Wiki IPC sender')
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  const registeredWorkspaceId = ownerWindow && getRegisteredWindowWorkspace(ownerWindow)
  if (!registeredWorkspaceId || requestedWorkspaceId !== registeredWorkspaceId)
    throw new Error('WIKI_WORKSPACE_UNAVAILABLE')
  return authorizeChannelSessionWorkspace(registeredWorkspaceId, loadOfflineWorkspaceIds)
}

export function registerWikiHandlers(): void {
  ipcMain.handle(
    'wiki:generate',
    async (event, args: ProjectWikiGenerateRequest & { workspaceId: string }) => {
      const workspaceId = await authorizeWikiWorkspace(event, args?.workspaceId)
      const projectRoot = validateProjectRoot(args.projectRoot)
      const sharedFiles = await getSharedIndexedFiles(projectRoot)
      const document = generateProjectWiki({ ...args, projectRoot }, sharedFiles, workspaceId)
      await authorizeWikiWorkspace(event, workspaceId)
      await saveWikiDocument(document, workspaceId)
      return document
    }
  )
  ipcMain.handle('wiki:get', async (event, args: { projectRoot: string; workspaceId: string }) => {
    const workspaceId = await authorizeWikiWorkspace(event, args?.workspaceId)
    const projectRoot = validateProjectRoot(args.projectRoot)
    const document =
      (await loadWikiDocument(projectRoot, workspaceId)) ??
      loadProjectWiki(projectRoot, workspaceId)
    await authorizeWikiWorkspace(event, workspaceId)
    return document
  })
  ipcMain.handle(
    'wiki:export',
    async (event, args: { projectRoot: string; destination: string; workspaceId: string }) => {
      const workspaceId = await authorizeWikiWorkspace(event, args?.workspaceId)
      const projectRoot = validateProjectRoot(args.projectRoot)
      const document =
        (await loadWikiDocument(projectRoot, workspaceId)) ??
        loadProjectWiki(projectRoot, workspaceId) ??
        generateProjectWiki({ projectRoot }, await getSharedIndexedFiles(projectRoot), workspaceId)
      await authorizeWikiWorkspace(event, workspaceId)
      await saveWikiDocument(document, workspaceId)
      await authorizeWikiWorkspace(event, workspaceId)
      writeProjectWikiMarkdown(document, args.destination)
      return { success: true, destination: args.destination }
    }
  )
}
