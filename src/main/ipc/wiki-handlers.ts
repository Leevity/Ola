import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ProjectWikiGenerateRequest } from '../../shared/project-wiki'
import {
  generateProjectWiki,
  loadProjectWiki,
  writeProjectWikiMarkdown,
  type SharedIndexedFile
} from '../wiki/wiki-service'
import { loadWikiDocument, saveWikiDocument } from '../db/capability-dao'
import { getCodeGraphWorker } from '../lib/codegraph-worker'

async function getSharedIndexedFiles(projectRoot: string): Promise<SharedIndexedFile[] | undefined> {
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

export function registerWikiHandlers(): void {
  ipcMain.handle('wiki:generate', async (event, args: ProjectWikiGenerateRequest) => {
    if (!isTrustedWikiIpcSender(event)) throw new Error('Unauthorized Wiki IPC sender')
    const sharedFiles = await getSharedIndexedFiles(args.projectRoot)
    const document = generateProjectWiki(args, sharedFiles)
    await saveWikiDocument(document)
    return document
  })
  ipcMain.handle('wiki:get', async (event, args: { projectRoot: string }) => {
    if (!isTrustedWikiIpcSender(event)) throw new Error('Unauthorized Wiki IPC sender')
    return (await loadWikiDocument(args.projectRoot)) ?? loadProjectWiki(args.projectRoot)
  })
  ipcMain.handle(
    'wiki:export',
    async (event, args: { projectRoot: string; destination: string }) => {
      if (!isTrustedWikiIpcSender(event)) throw new Error('Unauthorized Wiki IPC sender')
      const document =
        (await loadWikiDocument(args.projectRoot)) ??
        loadProjectWiki(args.projectRoot) ??
        generateProjectWiki(
          { projectRoot: args.projectRoot },
          await getSharedIndexedFiles(args.projectRoot)
        )
      await saveWikiDocument(document)
      writeProjectWikiMarkdown(document, args.destination)
      return { success: true, destination: args.destination }
    }
  )
}
